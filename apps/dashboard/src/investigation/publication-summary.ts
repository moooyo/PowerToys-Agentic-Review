import type {
  InvestigationActionKind,
  InvestigationResultV1,
  InvestigationValidationCheck,
} from "@agentic-review/contracts";
import type { PublicationComposerDraft } from "./publication-composer";

function excerpt(value: string, limit: number): string {
  const text = value
    .replace(/```[\s\S]*?(?:```|$)/gu, " ")
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?)/gmu, "")
    .replace(/`+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const sentence = (text.split(/(?<=[.!?])\s+/u)[0] ?? "").replace(/[.!?]+$/u, "");
  if (sentence.length <= limit) return sentence;
  const prefix = sentence.slice(0, limit - 1);
  const wordBoundary = prefix.lastIndexOf(" ");
  return `${(wordBoundary > limit / 2 ? prefix.slice(0, wordBoundary) : prefix).trimEnd()}…`;
}

interface SummarySelection {
  topics: string[];
  findingCount: number;
}

function selectedTopics(
  draft: PublicationComposerDraft,
  result: InvestigationResultV1,
): SummarySelection {
  const seen = new Set<string>();
  const topics: string[] = [];
  let findingCount = 0;
  const findings = result.findings
    .filter((finding) => draft.selectedFindingIds.includes(finding.id))
    .sort((left, right) => left.priority.localeCompare(right.priority));
  for (const finding of findings) {
    const entry = draft.entries[finding.feedbackDraft.id];
    if (!entry || entry.draftId !== finding.feedbackDraft.id || seen.has(entry.draftId)) continue;
    const title = excerpt(finding.title, 90) || excerpt(entry.body, 90);
    if (title) {
      const qualification = finding.confirmation.status === "hypothesis" ? " hypothesis" : "";
      topics.push(`${finding.priority}${qualification}: ${title}`);
      seen.add(entry.draftId);
      findingCount += 1;
    }
  }
  for (const draftId of draft.selectedDraftIds) {
    const saved = result.feedbackDrafts.find((item) => item.id === draftId);
    const entry = draft.entries[draftId];
    if (!saved || !entry || entry.draftId !== draftId || seen.has(draftId)) continue;
    const body = excerpt(entry.body, 90);
    if (body) {
      topics.push(body);
      seen.add(draftId);
    }
  }
  return { topics, findingCount };
}

function opening(
  action: InvestigationActionKind | null,
  { topics, findingCount }: SummarySelection,
  result: InvestigationResultV1 | undefined,
): string {
  if (topics.length > 0) {
    const remaining = topics.length > 2 ? `; ${topics.length - 2} more selected items` : "";
    const detail = topics.slice(0, 2).join("; ") + remaining;
    const noun = findingCount === topics.length ? "finding" : "selected feedback item";
    const scope = `${topics.length} ${noun}${topics.length === 1 ? "" : "s"}`;
    if (action === "approve") return `Approving the reviewed revision with ${scope}: ${detail}`;
    if (action === "request-changes") return `Requesting changes for ${scope}: ${detail}`;
    if (action === "suggestion-comment") return `Suggested updates for ${scope}: ${detail}`;
    return `Review feedback on ${scope}: ${detail}`;
  }
  if (action === "approve") return "Approving the reviewed revision";
  const summary = result
    ? excerpt(result.assessment.summary, 150) || excerpt(result.report.summary, 150)
    : "";
  if (action === "request-changes")
    return summary
      ? `Requesting changes: ${summary}`
      : "Requesting changes to the reviewed revision";
  if (action === "suggestion-comment")
    return summary
      ? `Suggested updates: ${summary}`
      : "Suggesting updates to the reviewed revision";
  return summary ? `Investigation update: ${summary}` : "Sharing investigation feedback";
}

function statusCounts(statuses: InvestigationValidationCheck["status"][]): string {
  return (["failed", "blocked", "not_run", "passed"] as const)
    .flatMap((status) => {
      const count = statuses.filter((value) => value === status).length;
      return count > 0 ? [`${count} ${status.replace("_", " ")}`] : [];
    })
    .join(", ");
}

function recordedStatus(result: InvestigationResultV1 | undefined): string {
  if (!result) return "No investigation report is available";
  const clauses: string[] = [];
  if (result.outcome !== "completed") clauses.push(`Investigation ${result.outcome}`);
  if (result.report.completeness === "partial") clauses.push("report remains partial");
  const checks = statusCounts(result.validation.checks.map((check) => check.status));
  if (checks) clauses.push(`recorded validation: ${checks}`);
  const e2e = result.context.e2e;
  if (e2e) {
    if (e2e.blockers?.length) clauses.push("E2E build blocked");
    const features = statusCounts(e2e.features.map((feature) => feature.outcome));
    if (features) clauses.push(`recorded E2E features: ${features}`);
  } else if (!checks) {
    clauses.push("no validation checks are recorded");
  }
  const status = clauses.join("; ") || "No validation checks are recorded";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Draft a concise opening from selected feedback and recorded report facts, without a verdict. */
export function generatePublicationSummary(
  action: InvestigationActionKind | null,
  draft: PublicationComposerDraft,
  result?: InvestigationResultV1,
): string {
  const selection = result ? selectedTopics(draft, result) : { topics: [], findingCount: 0 };
  const summary = opening(action, selection, result);
  return `${summary}${summary.endsWith("…") ? "" : "."} ${recordedStatus(result)}.`;
}
