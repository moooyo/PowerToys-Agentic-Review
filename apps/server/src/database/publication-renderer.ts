import type {
  DashboardReviewRunDetail,
  DashboardReviewRunResult,
  DashboardValidationPolicy,
  PublicationPayloadV1,
  ReviewRunDecisionEvent,
} from "@agentic-review/contracts";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";

export const publicationRendererVersion = "publication-renderer-v1";
export const maximumPublicationBodyUtf8Bytes = 60_000;

export function publicationIdentity(
  repositoryId: string,
  reviewRunId: string,
  decisionId: string,
): string {
  return `publication-${sha256(canonicalJson({ repositoryId, reviewRunId, decisionId, rendererVersion: publicationRendererVersion }))}`;
}

function quoted(value: string): string {
  // Source content remains visible as quoted prose and cannot forge the publication marker.
  return value
    .replaceAll("<!--", "&lt;!--")
    .replaceAll("-->", "--&gt;")
    .split(/\r?\n/u)
    .map((line) => `> ${line}`)
    .join("\n");
}

export interface PublicationRenderInput {
  readonly publicationId: string;
  readonly decision: ReviewRunDecisionEvent;
  readonly detail: DashboardReviewRunDetail;
  readonly policy: DashboardValidationPolicy;
  readonly results: readonly DashboardReviewRunResult[];
}
export interface PublicationRenderedBody {
  readonly payload: PublicationPayloadV1;
  readonly payloadSha256: string;
  readonly semanticSha256: string;
}

/** A report is either complete within the wire budget or explicitly unavailable. Required
 * failures, lifecycle blockers and policy reasons are never shortened to fit the body. */
export function renderPublication(input: PublicationRenderInput): PublicationRenderedBody | null {
  const { decision, detail, policy } = input;
  if (
    decision.action === "withdraw" ||
    policy.reasonsTruncated ||
    policy.reasonCount !== policy.reasons.length
  )
    return null;
  const lines = [
    "## Validation report",
    `Repository: ${detail.repository}; work item: #${detail.number}`,
    `Review run: ${detail.id}`,
    `Reviewed revision: ${detail.revisionKey}`,
    `Source commit: ${detail.testedSourceRevision?.headSha ?? "Unavailable"}`,
    `Plan digest: ${detail.planDigest}`,
    `Result-set digest: ${decision.resultSetDigest}`,
    `Human decision: ${decision.action}; decision version: ${decision.version}`,
    "",
    "### Human decision reason",
    quoted(decision.reason),
    "",
    decision.action === "override_approve"
      ? "Qualified approval exception. This is a comment; failed or missing validation remains unchanged."
      : "The human decision, measured validation outcomes, and model advice are separate facts.",
    "",
    "### Validation policy",
    policy.applicable
      ? `Approval eligible: ${policy.eligible ? "yes" : "no"}.`
      : "Approval eligibility does not apply to Issues.",
    `Blocking findings: ${policy.blockingFindingCount}.`,
    ...(policy.policyVersion === "required-checks-and-unresolved-p0-p1-v2"
      ? [`Unresolved blocking findings: ${policy.unresolvedBlockingFindingCount}.`]
      : []),
    `Policy reasons: ${policy.reasonCount}.`,
  ];
  for (const reason of policy.reasons) {
    lines.push(
      `- ${reason.code}${reason.requestId ? `; request ${reason.requestId}` : ""}${reason.checkId ? `; check ${reason.checkId}` : ""}${reason.outcome ? `; ${reason.outcome}` : ""}`,
    );
    if (reason.reason) lines.push(quoted(reason.reason));
  }
  lines.push("", "### Workflow results");
  for (const request of detail.requests) {
    const result = input.results.find((candidate) => candidate.requestId === request.requestId);
    lines.push(
      "",
      `#### ${request.workflowKind} / ${request.target} / ${request.required ? "required" : "optional"}`,
      `Request: ${request.requestId}`,
    );
    if (!result) {
      lines.push(
        `Execution: ${request.latestJob?.status ?? "not_run"}; no authoritative result is available.`,
      );
      for (const blocker of request.blockers) lines.push(quoted(blocker));
      if (request.blockersTruncated) return null;
      continue;
    }
    lines.push(
      `Result: ${result.id}; digest: ${result.resultDigest}`,
      `Source: ${result.report.sourceState}; evidence complete: ${result.evidenceComplete ? "yes" : "no"}.`,
      quoted(result.report.summary),
    );
    lines.push(`Checks: ${result.report.checks.length}; all check outcomes follow.`);
    for (const check of result.report.checks) {
      lines.push(
        `- ${check.id}: ${check.outcome}; ${check.required ? "required" : "optional"}; source: ${check.source}`,
        quoted(check.summary),
      );
      if (check.expected !== null) lines.push("Expected:", quoted(check.expected));
      if (check.actual !== null) lines.push("Actual:", quoted(check.actual));
      if (check.evidenceIds.length)
        lines.push(`Evidence references: ${check.evidenceIds.join(", ")}`);
    }
    lines.push(`Lifecycle blockers: ${result.execution.blockers.length}.`);
    for (const blocker of result.execution.blockers)
      lines.push(`- ${blocker.phase}: ${blocker.code}`, quoted(blocker.message));
    const findings = [...result.modelReview.findings, ...result.modelReview.observations];
    lines.push(
      `Model review: ${result.modelReview.state}; recommendation: ${result.modelReview.recommendation ?? "none"}.`,
      `Model findings and observations: ${findings.length}; all entries follow.`,
    );
    if (result.modelReview.summary !== null) lines.push(quoted(result.modelReview.summary));
    for (const finding of findings) {
      lines.push(`- Priority P${finding.priority}`, quoted(finding.title), quoted(finding.body));
      if (finding.path !== null)
        lines.push(
          "Source location:",
          quoted(`${finding.path}${finding.line === null ? "" : `:${finding.line}`}`),
        );
    }
    if (result.modelReview.issueTriage) {
      const triage = result.modelReview.issueTriage;
      lines.push(
        `Model triage: ${triage.category}; priority P${triage.priority}; confidence ${triage.confidence}.`,
      );
      for (const label of triage.suggestedLabels) lines.push("Suggested label:", quoted(label));
      for (const missing of triage.missingInformation)
        lines.push("Missing information:", quoted(missing));
      for (const duplicate of triage.duplicateCandidates)
        lines.push(`Possible duplicate #${duplicate.number}:`, quoted(duplicate.reason));
    }
    if (result.report.workItemKind === "issue")
      lines.push(`Measured reproduction conclusion: ${result.report.reproductionConclusion}.`);
    if (result.modelReview.reproductionConclusion !== null)
      lines.push(`Model reproduction advice: ${result.modelReview.reproductionConclusion}.`);
  }
  const semanticBody = `${lines.join("\n")}\n`;
  const semanticSha256 = sha256(semanticBody);
  const body = `${semanticBody}\n<!-- agentic-review-publication:${input.publicationId} semantic-sha256:${semanticSha256} -->`;
  if (!body.isWellFormed() || Buffer.byteLength(body, "utf8") > maximumPublicationBodyUtf8Bytes)
    return null;
  let payload: PublicationPayloadV1;
  if (decision.workItemKind === "issue") payload = { kind: "issue_comment", body };
  else {
    const commitId = detail.testedSourceRevision?.headSha;
    if (!commitId) return null;
    payload = {
      kind: "pull_request_review",
      commitId,
      body,
      event:
        decision.action === "approve"
          ? "APPROVE"
          : decision.action === "request_changes"
            ? "REQUEST_CHANGES"
            : "COMMENT",
    };
  }
  return { payload, semanticSha256, payloadSha256: sha256(canonicalJson(payload)) };
}
