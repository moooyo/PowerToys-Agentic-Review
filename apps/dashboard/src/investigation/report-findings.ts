import type { InvestigationFindingV1 } from "@agentic-review/contracts";

export const findingPageSize = 25;
export const findingViewParameters = [
  "findingId",
  "findingSearch",
  "findingPriority",
  "findingAssessment",
  "findingPage",
] as const;

export interface FindingFilters {
  search: string;
  priority: "all" | InvestigationFindingV1["priority"];
  assessment: "all" | InvestigationFindingV1["confirmation"]["status"];
}

export function readFindingFilters(params: URLSearchParams): FindingFilters {
  const priority = params.get("findingPriority");
  const assessment = params.get("findingAssessment");
  return {
    search: params.get("findingSearch") ?? "",
    priority: ["P0", "P1", "P2", "P3"].includes(priority ?? "")
      ? (priority as InvestigationFindingV1["priority"])
      : "all",
    assessment: assessment === "confirmed" || assessment === "hypothesis" ? assessment : "all",
  };
}

export function filterReportFindings(
  findings: readonly InvestigationFindingV1[],
  filters: FindingFilters,
): InvestigationFindingV1[] {
  const search = filters.search.trim().toLocaleLowerCase();
  return findings.filter((finding) => {
    if (filters.priority !== "all" && finding.priority !== filters.priority) return false;
    if (filters.assessment !== "all" && finding.confirmation.status !== filters.assessment)
      return false;
    if (!search) return true;
    const text = [
      finding.title,
      finding.subjectRef,
      ...finding.locations.map((location) =>
        location.kind === "source"
          ? `${location.path}:${location.startLine}–${location.endLine}`
          : location.description,
      ),
      ...finding.trigger.conditions,
      ...finding.trigger.inputs,
      ...finding.trigger.steps,
      finding.impact.description,
      finding.rootCause.explanation,
      finding.confirmation.rationale,
      finding.fixRecommendation.summary,
      finding.feedbackDraft.body,
    ].join("\n");
    return text.toLocaleLowerCase().includes(search);
  });
}

export function reportFindingView(
  findings: readonly InvestigationFindingV1[],
  filters: FindingFilters,
  findingId: string | null,
  requestedPage: string | null,
) {
  const matching = filterReportFindings(findings, filters);
  const pageCount = Math.max(1, Math.ceil(matching.length / findingPageSize));
  const parsedPage = Number(requestedPage);
  const requested = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const linked = findingId ? findings.find((finding) => finding.id === findingId) : undefined;
  const linkedPosition = linked ? matching.findIndex((finding) => finding.id === linked.id) : -1;
  const page =
    linkedPosition >= 0
      ? Math.floor(linkedPosition / findingPageSize) + 1
      : Math.min(requested, pageCount);
  const offset = (page - 1) * findingPageSize;
  const visible = matching.slice(offset, offset + findingPageSize);
  const finding = findingId ? linked : visible[0];
  const position = finding ? matching.findIndex((entry) => entry.id === finding.id) : -1;
  return {
    matching,
    page,
    pageCount,
    offset,
    visible,
    finding,
    position,
    previous: position > 0 ? matching[position - 1] : undefined,
    next: position >= 0 ? matching[position + 1] : undefined,
    outsideFilters: Boolean(linked && linkedPosition < 0),
    unavailable: Boolean(findingId && !linked),
  };
}
