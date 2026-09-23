import type {
  InvestigationPlanV1,
  InvestigationResultV1,
  InvestigationSubjectV1,
} from "@agentic-review/contracts";
import type { WorkItem } from "./api";

export function savedPlanSubject(
  result: InvestigationResultV1 | undefined,
  plan: InvestigationPlanV1 | undefined,
): InvestigationSubjectV1 | undefined {
  return (
    plan &&
    result?.context.subjects.find(
      (subject) =>
        subject.id === plan.subjectRef &&
        subject.repositoryId === result.context.repository.id &&
        subject.workItemId === result.context.workItem.id,
    )
  );
}

export function savedSubjectDescription(subject: InvestigationSubjectV1 | undefined): string {
  if (!subject) return "Saved source is unavailable. Reload this report before preparing.";
  if (subject.kind === "source_commit") return `Saved commit · ${subject.commitSha}`;
  if (subject.kind === "original_pr") return `Saved PR head · ${subject.headSha}`;
  if (subject.kind === "remote_branch")
    return `Verified branch ${subject.branch} · ${subject.headSha}`;
  if (subject.kind === "local_patch") return `Saved patch · ${subject.id} · ${subject.patchDigest}`;
  return `Issue snapshot · ${subject.id}`;
}

/** Mirrors the saved assessment target accepted by the action service; it creates no new target. */
export function savedDuplicateTarget(
  result: InvestigationResultV1 | undefined,
  workItem: Pick<WorkItem, "repositoryId" | "kind" | "number">,
): { identifier: string; number: number } | null {
  if (
    !result ||
    workItem.kind !== "issue" ||
    result.context.repository.id !== workItem.repositoryId
  )
    return null;
  const assessment = result.assessment;
  const identifier =
    assessment.kind === "bug"
      ? assessment.bugAssessment.duplicateOf?.identifier
      : assessment.kind === "feature"
        ? assessment.featureAssessment.duplicateOf?.identifier
        : undefined;
  if (!identifier) return null;
  const value = identifier.trim(),
    name = result.context.repository.fullName;
  let number =
    /^#?([1-9][0-9]*)$/u.exec(value)?.[1] ??
    (value.startsWith(`${name}#`)
      ? /^([1-9][0-9]*)$/u.exec(value.slice(name.length + 1))?.[1]
      : undefined);
  if (number === undefined) {
    try {
      const url = new URL(value),
        prefix = `/${name}/issues/`;
      if (
        url.protocol !== "https:" ||
        url.hostname !== "github.com" ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash ||
        !url.pathname.startsWith(prefix)
      )
        return null;
      const suffix = url.pathname.slice(prefix.length);
      if (/^[1-9][0-9]*$/u.test(suffix)) number = suffix;
    } catch {
      return null;
    }
  }
  const parsed = Number(number);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed !== workItem.number
    ? { identifier, number: parsed }
    : null;
}
