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

/** Resolve only a stale plan-kind link from an explicit, unambiguous accepted verification action. */
export function projectInvestigationReportAssessment(
  context: Omit<InvestigationNextActionResolutionContext, "nextActions">,
  proposals: readonly InvestigationNextActionDraft[],
  persistedPlans: readonly InvestigationPlanV1[],
): InvestigationResultV1["assessment"] {
  const { assessment } = context;
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
