import type {
  InvestigationCandidate,
  InvestigationReportRef,
  InvestigationResultV1,
  InvestigationReviewBaselineFindingRef,
  InvestigationReviewDisposition,
} from "./investigation.js";

export interface InvestigationReviewComparison {
  readonly baselineReportRef: InvestigationReportRef;
  readonly baselineHeadSha: string;
  readonly currentHeadSha: string | null;
  readonly findings: readonly {
    readonly baselineFindingRef: InvestigationReviewBaselineFindingRef;
    readonly title: string;
    readonly status: InvestigationReviewDisposition;
    readonly candidateId: string | null;
    readonly currentFindingRef: InvestigationReviewBaselineFindingRef | null;
    readonly rationale: string;
    readonly evidenceRefs: readonly string[];
  }[];
  readonly newFindingIds: readonly string[];
}

/** Presentation follows typed review conclusions and never infers a fix from missing findings. */
export function deriveInvestigationReviewComparison(
  result: InvestigationResultV1,
): InvestigationReviewComparison | null {
  const baseline = result.context.reviewBaseline;
  if (baseline === undefined) return null;
  const subject = result.context.subjects.find(
    (entry) => entry.id === result.context.task.subjectRef,
  );
  const candidates = new Map(result.report.loop.candidates.map((entry) => [entry.id, entry]));
  const currentFindings = new Map(result.findings.map((entry) => [entry.id, entry]));
  const associated = new Set<string>();
  const findings = baseline.findings.map((previous) => {
    const candidate = result.report.loop.candidates.find(
      (entry) =>
        entry.subjectRef === result.context.task.subjectRef &&
        entry.reviewBaselineFindingRef?.id === previous.id &&
        entry.reviewBaselineFindingRef.version === previous.version,
    );
    const status = candidate?.reviewDisposition ?? "pending";
    let current: InvestigationCandidate | undefined = candidate;
    const seen = new Set<string>();
    while (current?.status === "merged" && !seen.has(current.id)) {
      seen.add(current.id);
      current =
        current.mergedIntoCandidateId === null
          ? undefined
          : candidates.get(current.mergedIntoCandidateId);
    }
    const finding =
      current?.findingId === null || current?.findingId === undefined
        ? undefined
        : currentFindings.get(current.findingId);
    const currentFindingRef =
      (status === "still_present" || status === "unverified") &&
      current !== undefined &&
      finding !== undefined &&
      finding.subjectRef === result.context.task.subjectRef &&
      finding.version === current.findingVersion &&
      (current.status === "confirmed" || current.status === "unresolved")
        ? { id: finding.id, version: finding.version }
        : null;
    if (currentFindingRef !== null) associated.add(currentFindingRef.id);
    return {
      baselineFindingRef: { id: previous.id, version: previous.version },
      title: previous.title,
      status,
      candidateId: candidate?.id ?? null,
      currentFindingRef,
      rationale:
        candidate?.rationale ??
        "This previous finding has not been rechecked against the current PR source.",
      evidenceRefs: [...(candidate?.evidenceRefs ?? [])],
    };
  });
  return {
    baselineReportRef: { ...baseline.reportRef },
    baselineHeadSha: baseline.subject.headSha,
    currentHeadSha: subject?.kind === "original_pr" ? subject.headSha : null,
    findings,
    newFindingIds: result.findings
      .filter((finding) => !associated.has(finding.id))
      .map((finding) => finding.id),
  };
}
