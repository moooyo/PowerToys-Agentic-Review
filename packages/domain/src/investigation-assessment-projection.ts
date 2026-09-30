import {
  type InvestigationNextActionDraft,
  type InvestigationPlanV1,
  type InvestigationResultV1,
  investigationPlanDigestPayload,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "./investigation-loop.js";
import {
  type InvestigationNextActionResolutionContext,
  validateInvestigationNextActions,
} from "./investigation-policy.js";

/** Preserve trusted follow-up plan identity and resolve explicit accepted verification actions. */
export function projectInvestigationReportAssessment(
  context: Omit<InvestigationNextActionResolutionContext, "nextActions">,
  proposals: readonly InvestigationNextActionDraft[],
  persistedPlans: readonly InvestigationPlanV1[],
  trustedParentPlan?: InvestigationPlanV1 | null,
): InvestigationResultV1["assessment"] {
  const { assessment } = context;
  const parentReport = context.context.parentReportRef;
  const subject = context.context.subjects.find((entry) => entry.id === assessment.subjectRef);
  if (
    context.context.task.kind === "pr-verify" &&
    context.context.task.parentTaskId !== null &&
    assessment.kind === "pr" &&
    assessment.e2eAssessment.level !== "not_needed" &&
    assessment.e2eAssessment.planRef === null &&
    assessment.subjectRef === context.context.task.subjectRef &&
    subject?.kind === "original_pr" &&
    subject.repositoryId === context.context.repository.id &&
    subject.workItemId === context.context.workItem.id &&
    trustedParentPlan !== undefined &&
    trustedParentPlan !== null &&
    trustedParentPlan.state === "saved" &&
    trustedParentPlan.kind === "verification" &&
    trustedParentPlan.subjectRef === assessment.subjectRef &&
    parentReport !== null &&
    trustedParentPlan.sourceReportRef.id === parentReport.id &&
    trustedParentPlan.sourceReportRef.version === parentReport.version &&
    trustedParentPlan.digest ===
      investigationContentDigest(investigationPlanDigestPayload(trustedParentPlan)) &&
    persistedPlans.some(
      (plan) => investigationContentDigest(plan) === investigationContentDigest(trustedParentPlan),
    )
  )
    return {
      ...assessment,
      e2eAssessment: {
        ...assessment.e2eAssessment,
        planRef: {
          id: trustedParentPlan.id,
          version: trustedParentPlan.version,
          digest: trustedParentPlan.digest,
        },
      },
    };
  if (
    assessment.kind !== "bug" ||
    assessment.bugAssessment.status !== "needs_verification" ||
    assessment.bugAssessment.hypotheses.length === 0
  )
    return assessment;

  const resolve = (reference: InvestigationNextActionDraft["planRef"]) => {
    if (reference === null) return undefined;
    const matches = persistedPlans.filter(
      (plan) =>
        plan.id === reference.id &&
        plan.version === reference.version &&
        plan.digest === reference.digest &&
        plan.state === "saved" &&
        plan.subjectRef === assessment.subjectRef &&
        plan.digest === investigationContentDigest(investigationPlanDigestPayload(plan)),
    );
    return matches.length === 1 ? matches[0] : undefined;
  };
  const previous = resolve(assessment.reproduction.planRef);
  if (
    previous === undefined ||
    previous.kind === "verification" ||
    previous.kind === "reproduction"
  )
    return assessment;

  const recommended = proposals.filter(
    (action) =>
      action.recommended &&
      action.action === "start-task" &&
      action.taskKind === "issue-verify" &&
      action.subjectRef === assessment.subjectRef,
  );
  if (recommended.length !== 1) return assessment;
  const proposal = recommended[0]!;
  const replacement = resolve(proposal.planRef);
  if (replacement?.kind !== "verification") return assessment;
  const [validation] = validateInvestigationNextActions(
    {
      ...context,
      nextActions: [
        {
          ...proposal,
          state: "saved",
          sourceReportRef: { id: context.report.id, version: context.report.version },
        },
      ],
    },
    persistedPlans,
  );
  if (!validation?.valid) return assessment;

  return {
    ...assessment,
    reproduction: { ...assessment.reproduction, planRef: { ...proposal.planRef! } },
  };
}
