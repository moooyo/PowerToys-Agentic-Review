import type {
  ActionContextV1,
  InvestigationActionKind,
  InvestigationFindingsPageV1,
  InvestigationReportHeaderV1,
  InvestigationResultV1,
} from "@agentic-review/contracts";
import type { FeedbackSelectionContext } from "./feedback-selection";

export function selectionContext(
  context: ActionContextV1,
): FeedbackSelectionContext<InvestigationActionKind> {
  return {
    reportId: context.reportRef?.id ?? `work-item:${context.workItemId}`,
    reportVersion: context.reportRef?.version ?? 0,
    recommendedAction: context.recommendation.action,
    suggestionOptions: context.suggestionSelectionDefaults.map((option) => ({
      ...option,
      suggestionId: option.draftId,
    })),
  };
}

export function assertReportBindings(
  header: InvestigationReportHeaderV1,
  result: InvestigationResultV1,
): void {
  if (
    header.report.id !== result.report.id ||
    header.report.version !== result.report.version ||
    header.report.logicalContentDigest !== result.report.logicalContentDigest ||
    header.id !== result.id ||
    header.version !== result.version ||
    header.context.repository.id !== result.context.repository.id ||
    header.context.task.id !== result.context.task.id ||
    header.context.workItem.id !== result.context.workItem.id ||
    header.context.workItem.kind !== result.context.workItem.kind ||
    header.context.workItem.number !== result.context.workItem.number ||
    header.outcome !== result.outcome ||
    header.report.delivery !== result.report.delivery ||
    header.report.completeness !== result.report.completeness ||
    JSON.stringify(header.report.usage) !== JSON.stringify(result.report.usage) ||
    header.report.collections.findings !== result.findings.length ||
    header.report.collections.verificationEvidence !== result.verificationEvidence.length ||
    header.report.collections.artifacts !== result.artifacts.length ||
    header.report.collections.plans !== result.plans.length ||
    header.report.collections.nextActions !== result.nextActions.length ||
    header.report.collections.candidates !== result.report.loop.candidates.length ||
    header.report.collections.rechecks !== result.report.recheck.records.length
  ) {
    throw new Error(
      "The report details do not match the immutable report header. Refresh before preparing any action.",
    );
  }
}

export function assertFindingsPage(
  header: InvestigationReportHeaderV1,
  page: InvestigationFindingsPageV1,
): void {
  const end = page.offset + page.items.length;
  if (
    page.reportRef.id !== header.report.id ||
    page.reportRef.version !== header.report.version ||
    page.reportRef.digest !== header.report.logicalContentDigest ||
    page.total !== header.report.collections.findings ||
    end > page.total ||
    new Set(page.items.map((item) => item.id)).size !== page.items.length ||
    (page.nextCursor === null ? end !== page.total : page.items.length === 0 || end >= page.total)
  ) {
    throw new Error(
      "This findings page does not match the complete report collection. Refresh to load the current report.",
    );
  }
}

export function assertActionContext(
  header: InvestigationReportHeaderV1,
  context: ActionContextV1,
): void {
  if (
    context.workItemId !== header.context.workItem.id ||
    context.repositoryId !== header.context.repository.id ||
    context.reportRef?.id !== header.report.id ||
    context.reportRef.version !== header.report.version ||
    context.reportRef.digest !== header.report.logicalContentDigest
  ) {
    throw new Error("The server action context is not bound to the displayed report.");
  }
}
