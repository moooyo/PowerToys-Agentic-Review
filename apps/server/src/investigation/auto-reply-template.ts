import {
  EntityIdSchema,
  type InvestigationAssessment,
  type InvestigationFindingV1,
  type InvestigationLocation,
  type InvestigationModelExecution,
  InvestigationModelExecutionSchema,
  type InvestigationResultV1,
  type InvestigationSubjectV1,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { InvestigationRequestError } from "./errors.js";

export const automaticReplyTemplateVersion = 4;

export const automaticReplyTemplateTokens = {
  pullRequest: ["identity", "conclusion", "summary", "findings", "details"],
  issue: ["identity", "conclusion", "next_steps", "details"],
} as const;
export type AutomaticReplyTemplateKind = keyof typeof automaticReplyTemplateTokens;
type Token = (typeof automaticReplyTemplateTokens)[AutomaticReplyTemplateKind][number];

export const defaultAutomaticReplyTemplates = Object.freeze({
  pullRequest: `{{identity}}

## Conclusion

{{conclusion}}

## Summary

{{summary}}

## Findings

{{findings}}

{{details}}
`,
  issue: `{{identity}}

## Triage result

{{conclusion}}

## Next steps

{{next_steps}}

{{details}}
`,
});

export function validateAutomaticReplyTemplate(
  template: unknown,
  kind: AutomaticReplyTemplateKind = "pullRequest",
): string {
  const tokens: readonly Token[] = automaticReplyTemplateTokens[kind];
  const invalid = (message: string): never => {
    throw new InvestigationRequestError(400, "automatic_reply_template_invalid", message);
  };
  if (typeof template !== "string" || template.trim().length === 0) {
    return invalid("An automatic reply template must be a non-empty string.");
  }
  if (Buffer.byteLength(template, "utf8") > 12_000) {
    return invalid("An automatic reply template must not exceed 12000 UTF-8 bytes.");
  }
  if (/\{\{\{|\}\}\}/u.test(template)) {
    return invalid("Automatic reply placeholders must use the exact {{token}} syntax.");
  }
  const found = new Map<string, number>();
  const order: string[] = [];
  const remaining = template.replace(/\{\{([^{}]*)\}\}/gu, (_, token: string) => {
    if (!tokens.includes(token as Token)) invalid(`Unknown automatic reply token: ${token}.`);
    found.set(token, (found.get(token) ?? 0) + 1);
    order.push(token);
    return "";
  });
  if (remaining.includes("{{") || remaining.includes("}}")) {
    return invalid("Automatic reply placeholders must use the exact {{token}} syntax.");
  }
  for (const token of tokens) {
    if (found.get(token) !== 1) {
      return invalid(`Automatic reply token {{${token}}} must appear exactly once.`);
    }
  }
  if (order.some((token, index) => token !== tokens[index])) {
    return invalid(`Automatic reply tokens must appear in the order ${tokens.join(", ")}.`);
  }
  if (
    !template.trimStart().startsWith("{{identity}}") ||
    !template.trimEnd().endsWith("{{details}}")
  ) {
    return invalid(
      "The identity token must be the first non-empty content, and the details token must be last.",
    );
  }
  return template;
}

function internalIdentifiers(report: InvestigationResultV1): string[] {
  const identifiers = new Set<string>();
  const visit = (value: unknown, key = ""): void => {
    if (typeof value === "string") {
      if (/(?:^id$|Id$|Ids$|Ref$|Refs$)/u.test(key)) identifiers.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
    } else if (value !== null && typeof value === "object") {
      for (const [name, item] of Object.entries(value)) visit(item, name);
    }
  };
  visit(report);
  return [...identifiers].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length);
}

function stripUnsafeControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return !(
        code <= 0x08 ||
        code === 0x0b ||
        code === 0x0c ||
        (code >= 0x0e && code <= 0x1f) ||
        code === 0x7f ||
        (code >= 0x200b && code <= 0x200f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069) ||
        code === 0xfeff
      );
    })
    .join("");
}

function redactPrivateText(value: string, identifiers: readonly string[]): string {
  let text = stripUnsafeControlCharacters(value.replace(/\r\n?/gu, "\n"))
    .replace(
      /(?:agentic-review-action|action-intent-binding):[A-Za-z0-9._:-]+/gu,
      "[publication marker omitted]",
    )
    .replace(
      /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/gu,
      "[credential omitted]",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+|sk-(?:proj-)?[A-Za-z0-9_-]{8,}|arw1_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gu,
      "[credential omitted]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/giu, "[credential omitted]")
    .replace(
      /((?:["']?)\b(?:(?:(?:access|refresh|id|auth|github|api|client|publisher|worker)[_-]?)?(?:password|passwd|secret|token|api[_-]?key|authorization|credential))(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu,
      "$1[credential omitted]",
    )
    .replace(
      /((?:["']?)[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CREDENTIAL)(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gu,
      "$1[credential omitted]",
    )
    .replace(
      /(--?(?:token|secret|password|passwd|api[_-]?key|authorization|credential)\s+)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu,
      "$1[credential omitted]",
    )
    .replace(/(?:https?|ssh):\/\/[^\s/<>()]+@[^\s<>()]+/giu, "[credential-bearing URL omitted]")
    .replace(/(?:file|vscode|codex):\/\/[^\s<>()]+/giu, "[private URL omitted]")
    .replace(
      /https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\])(?::\d+)?[^\s<>()]*/giu,
      "[private URL omitted]",
    )
    .replace(/(["'`])(?:[A-Za-z]:[\\/]|\\\\)[^\n]*?\1/gu, "[local path omitted]")
    .replace(/\b[A-Za-z]:[\\/][^\s"'`<>|;,()]*/gu, "[local path omitted]")
    .replace(/\\\\[^\s"'`<>|;,()]+/gu, "[local path omitted]")
    .replace(
      /\/(?:home|root|tmp|var|etc|Users|mnt|media|opt|private|workspace|workspaces|run|proc|sys|dev)\/[^\s"'`<>|;,()]*/gu,
      "[local path omitted]",
    );
  for (const identifier of identifiers)
    text = text.replaceAll(identifier, "[internal reference omitted]");
  return text;
}

/** Model prose is data, never executable Markdown, HTML, a notification, or a link destination. */
function publicText(
  value: string,
  identifiers: readonly string[],
  templateLiteral = false,
): string {
  // Entity encoding is deliberately last: pre-encoded HTML cannot become active HTML after rendering.
  const text = redactPrivateText(value, identifiers)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/@/gu, "@\u200b")
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]*):(?=\/\/|[^\s]*@)/gu, "$1\u200b:")
    .replace(/\b(javascript|data|mailto):/giu, "$1\u200b:")
    .replace(/\bwww\./giu, "www\u200b.");
  if (templateLiteral) return text.replace(/\\/gu, "\\\\").replace(/[[\]`~]/gu, "\\$&");
  return text
    .replace(/[\\`~*_{}[\]#!|]/gu, "\\$&")
    .replace(/^(\s*)([-+]|\d+[.)])(?=\s)/gmu, "$1\\$2")
    .trim();
}

function repositoryName(report: InvestigationResultV1): string | null {
  const name = report.context.repository.fullName;
  if (name !== name.trim() || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u.test(name))
    return null;
  return name.endsWith("/.") || name.endsWith("/..") ? null : name;
}

function repositoryPath(path: string): boolean {
  const hasAsciiControl = [...path].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  return (
    path.length > 0 &&
    !/^[/]/u.test(path) &&
    !/[\\:]/u.test(path) &&
    !hasAsciiControl &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function subjectSha(subject: InvestigationSubjectV1): string | null {
  const sha =
    subject.kind === "original_pr" || subject.kind === "remote_branch"
      ? subject.headSha
      : subject.kind === "source_commit"
        ? subject.commitSha
        : null;
  return sha !== null && sha === sha.trim() && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha)
    ? sha
    : null;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sourceUrl(
  report: InvestigationResultV1,
  location: InvestigationLocation,
  identifiers: readonly string[],
): string | null {
  if (location.kind !== "source" || !repositoryPath(location.path)) return null;
  const repository = repositoryName(report);
  const subject = report.context.subjects.find((item) => item.id === location.subjectRef);
  if (
    repository === null ||
    subject === undefined ||
    subject.repositoryId !== report.context.repository.id ||
    subject.workItemId !== report.context.workItem.id
  )
    return null;
  if (
    redactPrivateText(location.path, identifiers) !== location.path ||
    redactPrivateText(repository, identifiers) !== repository
  )
    return null;
  const sha = subjectSha(subject);
  if (
    sha === null ||
    !Number.isSafeInteger(location.startLine) ||
    location.startLine < 1 ||
    !Number.isSafeInteger(location.endLine) ||
    location.endLine < location.startLine
  )
    return null;
  const end = location.endLine === location.startLine ? "" : `-L${location.endLine}`;
  return `https://github.com/${repository}/blob/${sha}/${location.path.split("/").map(encodeSegment).join("/")}#L${location.startLine}${end}`;
}

const human = (value: string): string => value.replaceAll("_", " ").replaceAll("-", " ");
const status = (value: string): string => {
  const text = human(value);
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export interface AutomaticReplyIdentity {
  readonly githubUserId: number;
  readonly githubLogin: string;
}

export interface AutomaticReplyModelContext {
  readonly modelExecutions: readonly InvestigationModelExecution[];
  readonly completedRounds: number;
  readonly adoptedAttemptIds: readonly string[];
}

function recordedModels(context: AutomaticReplyModelContext | undefined): string[] | null {
  if (
    context === null ||
    typeof context !== "object" ||
    !Array.isArray(context.modelExecutions) ||
    !Array.isArray(context.adoptedAttemptIds) ||
    !Number.isSafeInteger(context.completedRounds) ||
    context.completedRounds < 1 ||
    context.modelExecutions.length !== context.completedRounds ||
    context.adoptedAttemptIds.length === 0 ||
    new Set(context.adoptedAttemptIds).size !== context.adoptedAttemptIds.length ||
    context.adoptedAttemptIds.some((id) => !Value.Check(EntityIdSchema, id)) ||
    context.modelExecutions.some(
      (execution) => !Value.Check(InvestigationModelExecutionSchema, execution),
    )
  )
    return null;
  const executions = context.modelExecutions;
  const rounds = context.completedRounds;
  const coveredRounds = new Set<number>();
  const models = new Set<string>();
  for (const execution of [...executions].sort((left, right) => left.round - right.round)) {
    if (
      !Number.isSafeInteger(execution.round) ||
      execution.round < 1 ||
      execution.round > rounds ||
      coveredRounds.has(execution.round) ||
      !context.adoptedAttemptIds.includes(execution.attemptId) ||
      typeof execution.model !== "string" ||
      execution.model.length === 0 ||
      execution.model.length > 256 ||
      stripUnsafeControlCharacters(execution.model) !== execution.model ||
      /\s/u.test(execution.model.replaceAll(" ", "")) ||
      execution.model.trim() !== execution.model ||
      redactPrivateText(execution.model, []) !== execution.model
    )
      return null;
    coveredRounds.add(execution.round);
    models.add(execution.model === "gpt-6-astra" ? "GPT-6 Astra" : execution.model);
  }
  return [...models];
}

/** The caller supplies a verified publishing account and trusted execution records only. */
export function renderAutomaticReplyIdentity(
  report: InvestigationResultV1 | undefined,
  identity: AutomaticReplyIdentity,
  trustedModels?: AutomaticReplyModelContext,
): string {
  if (
    identity === null ||
    typeof identity !== "object" ||
    !Number.isSafeInteger(identity.githubUserId) ||
    identity.githubUserId < 1 ||
    typeof identity.githubLogin !== "string" ||
    identity.githubLogin !== identity.githubLogin.trim() ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?(?:\[bot\])?$/u.test(identity.githubLogin)
  ) {
    throw new InvestigationRequestError(
      400,
      "automatic_reply_identity_invalid",
      "Automatic replies require the verified GitHub user ID and a valid GitHub login.",
    );
  }
  const context =
    report === undefined
      ? trustedModels
      : {
          modelExecutions: report.context.modelExecutions ?? [],
          completedRounds: report.report.loop.completedRounds,
          adoptedAttemptIds: report.context.adoptedAttemptIds,
        };
  const models = recordedModels(context)?.map((model) => publicText(model, []));
  const modelIdentity =
    models === undefined
      ? "an AI assistant"
      : models.length === 1
        ? `${models[0]}, an AI assistant`
        : `an AI assistant using ${models.slice(0, -1).join(", ")} and ${models.at(-1)}`;
  const introduction = `I'm ${modelIdentity} running through Agentic Review on behalf of GitHub user \`@${identity.githubLogin}\`.`;
  if (report === undefined)
    return `${introduction} This update was generated by AI and may contain errors.`;
  const modelDisclosure = models === undefined ? " The model identity was not fully recorded." : "";
  if (report.context.task.kind === "pr-review")
    return `${introduction}${modelDisclosure} I'm performing this automated review. This review was generated by AI and may contain errors.`;
  const activity = report.assessment.kind === "bug" ? "bug triage" : "issue triage";
  return `${introduction}${modelDisclosure} I'm conducting this automated ${activity}. This triage was generated by AI and may contain errors.`;
}

class ReplySections {
  private readonly identifiers: readonly string[];

  constructor(private readonly report: InvestigationResultV1) {
    this.identifiers = internalIdentifiers(report);
  }

  text(value: string): string {
    return publicText(value, this.identifiers);
  }

  template(value: string): string {
    return publicText(value, this.identifiers, true);
  }

  private field(label: string, value: string): string {
    return `**${label}:** ${this.text(value).replaceAll("\n", "\n  ")}`;
  }

  private list(label: string, values: readonly string[]): string {
    return values.length === 0
      ? ""
      : `**${label}:**\n\n${values.map((value) => `- ${this.text(value).replaceAll("\n", "\n  ")}`).join("\n")}`;
  }

  private brief(value: string, maximum: number): string {
    const safe = redactPrivateText(value, this.identifiers).replace(/\s+/gu, " ").trim();
    const characters = [...safe];
    return publicText(
      characters.length <= maximum ? safe : `${characters.slice(0, maximum - 1).join("")}…`,
      [],
    );
  }

  private subject(id: string): string {
    const subject = this.report.context.subjects.find((item) => item.id === id);
    if (subject === undefined) return "Unspecified source scope";
    const sha = subjectSha(subject);
    switch (subject.kind) {
      case "original_pr":
        return sha === null
          ? "Original PR, source identity unavailable"
          : `Original PR at head ${sha}`;
      case "source_commit":
        return sha === null ? "Source commit, identity unavailable" : `Source commit ${sha}`;
      case "remote_branch":
        return sha === null
          ? "Remote branch, source identity unavailable"
          : `Remote branch at head ${sha}`;
      case "issue_snapshot":
        return "Frozen issue text and discussion snapshot";
      case "local_patch":
        return "Proposed local patch (not the original source)";
    }
  }

  private reference(
    label: string,
    reference: { identifier: string; explanation: string } | null,
  ): string {
    return reference === null
      ? ""
      : this.field(label, `${reference.identifier} — ${reference.explanation}`);
  }

  private issueExplanation(rationale: string): string {
    const statements = [this.report.report.summary, rationale].map((value) =>
      redactPrivateText(value, this.identifiers).replace(/\s+/gu, " ").trim(),
    );
    return [...new Set(statements)]
      .filter(Boolean)
      .map((statement) => this.brief(statement, 350))
      .join("\n\n");
  }

  conclusion(): string {
    const assessment = this.report.assessment;
    switch (assessment.kind) {
      case "pr":
        return `${status(assessment.reviewConclusion.status)}. End-to-end validation: ${human(assessment.e2eAssessment.level)}.`;
      case "bug": {
        const labels = {
          confirmed: "Confirmed bug",
          needs_information: "Needs more information",
          needs_verification: "Needs verification",
          already_fixed: "Already fixed upstream",
          duplicate: "Duplicate",
          not_a_bug: "Expected behavior",
        };
        return [
          `**${labels[assessment.bugAssessment.status]}.**`,
          this.issueExplanation(assessment.bugAssessment.rationale),
          `**Runtime reproduction:** ${assessment.reproduction.status === "not_run" ? "Not attempted" : status(assessment.reproduction.status)}.\n${this.brief(assessment.reproduction.summary, 240)}`,
        ].join("\n\n");
      }
      case "feature":
        return `**Classification:** Feature request.\n\n**Assessment:** ${status(assessment.featureAssessment.status)}.\n${this.issueExplanation(assessment.featureAssessment.feasibility)}`;
      case "other_issue":
        return `**Classification:** ${this.brief(assessment.classification, 160)}.\n${this.issueExplanation(assessment.explanation)}`;
    }
  }

  private proposedPlan(plan: InvestigationResultV1["plans"][number]): string {
    return [
      this.field(`Proposed ${human(plan.kind)} plan`, plan.title),
      this.brief(plan.rationale, 350),
      "See Investigation details for the procedure and recorded validation results.",
    ].join("\n\n");
  }

  issueNextSteps(): string {
    const assessment = this.report.assessment;
    if (assessment.kind === "pr") return "";
    if (assessment.kind === "bug") {
      const bug = assessment.bugAssessment;
      switch (bug.status) {
        case "needs_information":
          return [
            "Could you provide:",
            bug.missingInformation
              .map((item) => `- ${this.text(item).replaceAll("\n", "\n  ")}`)
              .join("\n"),
          ].join("\n\n");
        case "needs_verification": {
          const reference = assessment.reproduction.planRef;
          const plan = this.report.plans.find(
            (item) =>
              reference !== null &&
              item.id === reference.id &&
              item.version === reference.version &&
              item.subjectRef === assessment.subjectRef &&
              ["verification", "reproduction"].includes(item.kind),
          );
          return [
            "For maintainers: Verify the reported behavior and suspected cause using the proposed investigation plan.",
            this.list("Unconfirmed hypotheses", bug.hypotheses),
            plan === undefined
              ? "No matching verification procedure was recorded."
              : this.proposedPlan(plan),
          ].join("\n\n");
        }
        case "confirmed": {
          const findings = this.report.findings.filter(
            (finding) =>
              finding.subjectRef === assessment.subjectRef &&
              finding.confirmation.status === "confirmed",
          );
          return [
            "For maintainers: Address the confirmed defect and validate the fix against the reported behavior.",
            this.list(
              "Suggested fixes",
              findings.map((finding) => `${finding.title}: ${finding.fixRecommendation.summary}`),
            ),
            ...this.report.plans
              .filter((plan) => plan.subjectRef === assessment.subjectRef && plan.kind === "fix")
              .map((plan) => this.proposedPlan(plan)),
          ]
            .filter(Boolean)
            .join("\n\n");
        }
        case "already_fixed":
          return [
            this.reference("Upstream fix", bug.upstreamFix),
            "For the reporter: Check whether the referenced fix is present in your build, then verify the original scenario.",
          ]
            .filter(Boolean)
            .join("\n\n");
        case "duplicate":
          return [
            this.reference("Original issue", bug.duplicateOf),
            "Recommended next action: Continue the discussion and add any new reproduction information to the referenced issue.",
          ]
            .filter(Boolean)
            .join("\n\n");
        case "not_a_bug":
          return [
            this.field("Expected behavior", bug.expectedBehavior ?? "Not specified in the report."),
            "For the reporter: Compare the observed behavior with this explanation. If they differ, provide the exact steps and result.",
          ].join("\n\n");
      }
    }
    if (assessment.kind === "feature") {
      const feature = assessment.featureAssessment;
      switch (feature.status) {
        case "needs_information":
          return [
            "For the reporter: Please clarify the requested behavior.",
            this.list("Information needed", feature.missingInformation),
          ].join("\n\n");
        case "needs_decision":
          return [
            "For maintainers: Resolve the following product decisions before implementation.",
            ...feature.decisions.map((decision) =>
              [
                this.field("Decision needed", decision.question),
                this.list(
                  "Options",
                  decision.options.map((option) => `${option.label}: ${option.tradeoffs}`),
                ),
              ].join("\n\n"),
            ),
          ].join("\n\n");
        case "already_supported":
          return this.field(
            "Existing usage",
            feature.usage ?? "No usage instructions were recorded.",
          );
        case "duplicate":
          return [
            this.reference("Original issue", feature.duplicateOf),
            "Recommended next action: Continue the feature discussion in the referenced issue.",
          ]
            .filter(Boolean)
            .join("\n\n");
        case "not_feasible":
          return [
            "For maintainers and the reporter: Consider the recorded alternatives.",
            this.list("Alternatives", feature.alternatives),
          ].join("\n\n");
        case "ready": {
          const reference = feature.implementationPlanRef;
          const plan = this.report.plans.find(
            (item) =>
              reference !== null &&
              item.id === reference.id &&
              item.version === reference.version &&
              item.subjectRef === assessment.subjectRef &&
              item.kind === "implementation",
          );
          return [
            "For maintainers: Confirm the requirements and acceptance criteria before starting implementation.",
            this.list("Requirements", feature.requirements),
            this.list("Acceptance criteria", feature.acceptanceCriteria),
            plan === undefined
              ? "No matching implementation procedure was recorded."
              : this.proposedPlan(plan),
          ].join("\n\n");
        }
      }
    }
    return "For maintainers: Use the classification above and the evidence in Investigation details to determine the appropriate follow-up. No bug-specific action was established by this triage.";
  }

  assessment(): string {
    const assessment = this.report.assessment;
    const sections: string[] = [];
    switch (assessment.kind) {
      case "pr":
        sections.push(
          `**Review conclusion:** ${status(assessment.reviewConclusion.status)}.`,
          this.text(assessment.reviewConclusion.rationale),
          `**End-to-end validation:** ${status(assessment.e2eAssessment.level)}. ${this.text(assessment.e2eAssessment.rationale)}`,
        );
        break;
      case "bug":
        sections.push(
          `**Bug assessment:** ${status(assessment.bugAssessment.status)}.`,
          this.text(assessment.bugAssessment.rationale),
          this.field(
            "Expected behavior",
            assessment.bugAssessment.expectedBehavior ?? "Not specified in the report.",
          ),
          `**Reproduction:** ${status(assessment.reproduction.status)}. ${this.text(assessment.reproduction.summary)}`,
          this.evidence(assessment.reproduction.evidenceRefs),
          this.list("Information needed", assessment.bugAssessment.missingInformation),
          this.list("Unconfirmed hypotheses", assessment.bugAssessment.hypotheses),
          this.reference("Existing fix", assessment.bugAssessment.upstreamFix),
          this.reference("Duplicate reference", assessment.bugAssessment.duplicateOf),
        );
        break;
      case "feature": {
        const feature = assessment.featureAssessment;
        sections.push(
          `**Feature assessment:** ${status(feature.status)}.`,
          this.field("Feasibility", feature.feasibility),
          this.list("Requirements", feature.requirements),
          this.list("Information needed", feature.missingInformation),
          ...feature.decisions.map((decision) =>
            [
              this.field("Decision needed", decision.question),
              ...decision.options.map(
                (option) => `- ${this.text(option.label)}: ${this.text(option.tradeoffs)}`,
              ),
            ].join("\n\n"),
          ),
          this.list("Acceptance criteria", feature.acceptanceCriteria),
          this.list("Alternatives", feature.alternatives),
          feature.usage === null ? "" : this.field("Existing usage", feature.usage),
          this.reference("Duplicate reference", feature.duplicateOf),
        );
        break;
      }
      case "other_issue":
        sections.push(
          this.field("Classification", assessment.classification),
          this.text(assessment.explanation),
        );
        break;
    }
    return sections.filter(Boolean).join("\n\n");
  }

  summary(): string {
    return this.brief(this.report.report.summary, 500);
  }

  private fullSummary(): string {
    return [...new Set([this.report.report.summary, this.report.assessment.summary])]
      .map((value) => this.text(value))
      .join("\n\n");
  }

  private evidence(refs: readonly string[]): string {
    const selected = new Set(refs);
    return this.list(
      "Supporting evidence",
      this.report.verificationEvidence
        .filter((item) => selected.has(item.id))
        .map(
          (item) =>
            `${status(item.source)}; ${item.authority} (${this.subject(item.subjectRef)}): ${item.summary}`,
        ),
    );
  }

  private finding(finding: InvestigationFindingV1, index: number): string {
    const rechecks = this.report.report.recheck.records.filter(
      (item) =>
        item.findingId === finding.id &&
        item.findingVersion === finding.version &&
        item.subjectRef === finding.subjectRef,
    );
    const finalRecheck = rechecks.find((item) => item.id === finding.confirmation.recheckRef);
    const locations = finding.locations.map((location) => {
      if (location.kind !== "source")
        return `${status(location.kind)}: ${this.text(location.description)}`;
      const url = sourceUrl(this.report, location, this.identifiers);
      if (
        url === null &&
        (!repositoryPath(location.path) ||
          redactPrivateText(location.path, this.identifiers) !== location.path ||
          !Number.isSafeInteger(location.startLine) ||
          location.startLine < 1 ||
          !Number.isSafeInteger(location.endLine) ||
          location.endLine < location.startLine)
      ) {
        return "Source location unavailable for a public link.";
      }
      const lineRange =
        location.endLine === location.startLine
          ? `${location.startLine}`
          : `${location.startLine}–${location.endLine}`;
      return url === null
        ? `${this.text(location.path)}:${lineRange} (public source link unavailable).`
        : `[${this.text(location.path)}:${lineRange}](${url})`;
    });
    return [
      `#### ${index + 1}. [${finding.priority}] ${this.text(finding.title)}`,
      `**Status:** ${status(finding.confirmation.status)}. ${this.text(finding.confirmation.rationale)}`,
      this.field("Applies to", this.subject(finding.subjectRef)),
      this.list("Trigger conditions", finding.trigger.conditions),
      this.list("Inputs", finding.trigger.inputs),
      this.list("Trigger steps", finding.trigger.steps),
      this.field("Impact", finding.impact.description),
      this.list("Affected parties", finding.impact.affectedParties),
      `**Root cause:** ${status(finding.rootCause.status)}. ${this.text(finding.rootCause.explanation)}`,
      locations.length === 0
        ? ""
        : `**Locations:**\n\n${locations.map((location) => `- ${location}`).join("\n")}`,
      this.evidence([
        ...finding.evidenceRefs,
        ...finding.rootCause.evidenceRefs,
        ...finding.confirmation.evidenceRefs,
        ...rechecks.flatMap((item) => item.evidenceRefs),
      ]),
      ...rechecks.map((item) =>
        this.field(
          item === finalRecheck ? "Recheck conclusion" : "Earlier recheck conclusion",
          item.conclusion,
        ),
      ),
      this.list("Remaining uncertainty", finalRecheck?.unresolvedQuestions ?? []),
      this.field("Repair advice", finding.fixRecommendation.summary),
      this.list("Repair constraints", finding.fixRecommendation.constraints),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private sortedFindings(): InvestigationFindingV1[] {
    return [...this.report.findings].sort(
      (left, right) => left.priority.localeCompare(right.priority) || left.ordinal - right.ordinal,
    );
  }

  findings(): string {
    const findings = this.sortedFindings();
    if (findings.length === 0)
      return "No retained findings were recorded in the reviewed scope. See Details for validation results.";
    return findings
      .map((finding) => {
        const locations = finding.locations.flatMap((location) => {
          if (location.kind !== "source") return [];
          const url = sourceUrl(this.report, location, this.identifiers);
          if (url === null) return [];
          return [`[${this.brief(location.path, 96)}:${location.startLine}](${url})`];
        });
        const location =
          locations.length === 0
            ? ""
            : ` ${locations[0]}${locations.length > 1 ? ` (${locations.length - 1} more locations in Details.)` : ""}`;
        return `- **[${finding.priority}] ${this.brief(finding.title, 120)}** — **${status(finding.confirmation.status)}.** ${this.brief(finding.impact.description, 240)}${location}`;
      })
      .join("\n");
  }

  private detailedFindings(): string {
    const findings = this.sortedFindings();
    const retained = new Set(findings.map((item) => `${item.id}:${item.version}`));
    const additionalCandidates = this.report.report.loop.candidates.filter(
      (item) =>
        item.findingId === null ||
        !retained.has(`${item.findingId}:${item.findingVersion}`) ||
        item.status === "withdrawn" ||
        item.status === "merged",
    );
    return [
      findings.length === 0
        ? this.report.context.workItem.kind === "issue"
          ? "No additional finding analysis was recorded. See the triage assessment and validation results."
          : "No retained findings were recorded in the reviewed scope. Validation results are listed separately below."
        : findings.map((finding, index) => this.finding(finding, index)).join("\n\n"),
      additionalCandidates.length === 0
        ? ""
        : `**Other investigated candidates:**\n\n${additionalCandidates
            .map(
              (candidate) =>
                `- **${status(candidate.status)}:** ${this.text(candidate.title)} — ${this.text(candidate.rationale)}`,
            )
            .join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  validation(): string {
    return [
      this.report.validation.checks.length === 0
        ? "**Checks: Not run.** No validation checks were recorded in this report."
        : this.report.validation.checks
            .map((check) => {
              const evidence = this.evidence(check.evidenceRefs);
              return (
                `- **${status(check.status)}${check.required ? "; required" : ""}:** ${this.text(check.description)}\n  Subject: ${this.text(this.subject(check.subjectRef))}.` +
                (evidence === "" ? "" : `\n\n  ${evidence.replaceAll("\n", "\n  ")}`)
              );
            })
            .join("\n\n"),
      this.field("Validation summary", this.report.validation.summary),
    ].join("\n\n");
  }

  nextSteps(): string {
    const plans = this.report.plans.map((plan) =>
      [
        `**${status(plan.kind)} plan: ${this.text(plan.title)}**`,
        this.text(plan.rationale),
        this.list(
          "Prerequisites",
          plan.prerequisites
            .filter((item) => item.kind !== "authorization")
            .map((item) => item.description),
        ),
        ...plan.steps.map(
          (step, index) =>
            `${index + 1}. ${this.text(step.description)}\n   Expected observation: ${this.text(step.expectedObservation)}`,
        ),
        this.list("Acceptance criteria", plan.acceptanceCriteria),
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    // Draft publication and internal navigation actions are not instructions for the upstream reader.
    const actions = this.report.nextActions.filter(
      (action) =>
        action.recommended &&
        ![
          "comment",
          "suggestion-comment",
          "view-validation",
          "view-changes",
          "view-evidence",
          "resume",
        ].includes(action.action),
    );
    return (
      [
        ...plans,
        this.list(
          "Recommendations",
          actions.map((action) => `${action.label} — ${action.reason}`),
        ),
      ]
        .filter(Boolean)
        .join("\n\n") || "No additional next step was recorded in this report."
    );
  }

  scope(): string {
    const coverage = this.report.report.coverage;
    return [
      "This assessment applies to the frozen inputs below; later edits and pushes are outside this report.",
      this.list(
        "Subjects",
        this.report.context.subjects.map((subject) => {
          const base =
            subject.kind === "original_pr" &&
            subject.baseSha === subject.baseSha.trim() &&
            /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(subject.baseSha)
              ? `; base ${subject.baseSha}`
              : "";
          return `${this.subject(subject.id)}${base}`;
        }),
      ),
      this.list(
        "Scope covered",
        coverage.includedUnits.map(
          (unit) =>
            `${status(unit.status)}: ${unit.requiredWork}${unit.paths.length === 0 ? "" : ` Paths: ${unit.paths.filter(repositoryPath).join(", ") || "No public source path available."}`}`,
        ),
      ),
      this.list(
        "Excluded scope",
        coverage.exclusions.map((item) => `${item.description} — ${item.reason}`),
      ),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  limitations(): string {
    return (
      this.list(
        "Recorded limitations",
        this.report.report.limitations.map((item) => `${item.description} Impact: ${item.impact}`),
      ) || "No additional limitations were recorded in this report."
    );
  }

  details(): string {
    return [
      this.report.context.workItem.kind === "issue"
        ? "<details>\n<summary>Investigation details</summary>"
        : "<details>\n<summary>Details</summary>",
      "### Full assessment",
      this.assessment(),
      "### Full summary",
      this.fullSummary(),
      "### Finding analysis",
      this.detailedFindings(),
      "### Validation",
      this.validation(),
      "### Recommended next steps",
      this.nextSteps(),
      "### Scope",
      this.scope(),
      "### Limitations",
      this.limitations(),
      "</details>",
    ].join("\n\n");
  }
}

function rootAssessmentMatches(
  report: InvestigationResultV1,
  assessment: InvestigationAssessment,
): boolean {
  return report.context.task.kind === "pr-review"
    ? report.context.workItem.kind === "pull_request" && assessment.kind === "pr"
    : report.context.task.kind === "issue-investigate" &&
        report.context.workItem.kind === "issue" &&
        assessment.kind !== "pr";
}

function requireCompletedRootReport(report: InvestigationResultV1): void {
  if (
    report.outcome !== "completed" ||
    report.report.delivery !== "final" ||
    report.report.completeness !== "complete" ||
    report.report.loop.stopReason !== "complete" ||
    report.context.task.parentTaskId !== null ||
    report.context.parentReportRef !== null ||
    !rootAssessmentMatches(report, report.assessment)
  ) {
    throw new InvestigationRequestError(
      400,
      "automatic_reply_report_ineligible",
      "Automatic replies require a completed, final, complete root PR review or issue investigation report.",
    );
  }
}

export interface RenderedAutomaticReply {
  readonly identity: string;
  readonly content: string;
  readonly body: string;
}

/** Complete, untruncated parts for an enclosing progress comment that owns its final size limit. */
export function renderAutomaticReplyParts(
  report: InvestigationResultV1,
  template: string,
  identity: AutomaticReplyIdentity,
): RenderedAutomaticReply {
  const validated = validateAutomaticReplyTemplate(
    template,
    report.context.workItem.kind === "pull_request" ? "pullRequest" : "issue",
  );
  requireCompletedRootReport(report);
  const renderer = new ReplySections(report);
  const disclosure = renderAutomaticReplyIdentity(report, identity);
  const sections: Record<Token, string> = {
    identity: disclosure,
    conclusion: renderer.conclusion(),
    summary: renderer.summary(),
    findings: renderer.findings(),
    next_steps: renderer.issueNextSteps(),
    details: `\n\n${renderer.details()}`,
  };
  const rendered = validated
    .split(/(\{\{[a-z_]+\}\})/gu)
    .map((part) => {
      const match = /^\{\{([a-z_]+)\}\}$/u.exec(part);
      return match === null ? renderer.template(part) : sections[match[1] as Token];
    })
    .join("")
    .trim();
  const content = rendered.slice(disclosure.length).trimStart();
  return { identity: disclosure, content, body: `${disclosure}\n\n${content}` };
}

/** Removes only the exact server-generated disclosure from a matching report and publisher. */
export function automaticReplyResultWithoutIdentity(
  body: string,
  report: InvestigationResultV1,
  identity: AutomaticReplyIdentity,
): string {
  const disclosure = renderAutomaticReplyIdentity(report, identity);
  if (!body.startsWith(`${disclosure}\n`)) {
    throw new InvestigationRequestError(
      400,
      "automatic_reply_identity_mismatch",
      "The completed reply does not begin with the exact verified report identity.",
    );
  }
  return body.slice(disclosure.length).trimStart();
}

export function renderAutomaticReply(
  report: InvestigationResultV1,
  template: string,
  identity: AutomaticReplyIdentity,
): string {
  const { body } = renderAutomaticReplyParts(report, template, identity);
  if (Buffer.byteLength(body, "utf8") > 59_000) {
    throw new InvestigationRequestError(
      400,
      "automatic_reply_too_large",
      "The complete automatic reply exceeds 59000 UTF-8 bytes. Publication is blocked without truncating findings.",
    );
  }
  return body;
}

/** A separately labeled overview, never a truncated full report or a public report export. */
export function renderAutomaticReplySummaryParts(
  report: InvestigationResultV1,
  identity: AutomaticReplyIdentity,
): RenderedAutomaticReply {
  requireCompletedRootReport(report);
  const renderer = new ReplySections(report);
  const assessment = report.assessment;
  let conclusion: string;
  switch (assessment.kind) {
    case "pr":
      conclusion = `${status(assessment.reviewConclusion.status)}. End-to-end validation: ${human(assessment.e2eAssessment.level)}.`;
      break;
    case "bug":
      conclusion = `Bug triage: ${human(assessment.bugAssessment.status)}. Runtime reproduction: ${human(assessment.reproduction.status)}.`;
      break;
    case "feature":
      conclusion = `Feature request: ${human(assessment.featureAssessment.status)}.`;
      break;
    case "other_issue":
      conclusion =
        "Issue triage completed. Consult the complete assessment for its classification.";
      break;
  }
  const subject = report.context.subjects.find(
    (item) => item.id === report.context.task.subjectRef,
  );
  const sha = subject === undefined ? null : subjectSha(subject);
  const scope =
    report.context.workItem.kind === "pull_request"
      ? sha === null
        ? "The frozen pull request input recorded in this report. The reviewed commit is unavailable."
        : `Pull request reviewed at commit ${sha}. Later pushes are outside this report.`
      : "The frozen issue text and discussion snapshot recorded in this report. Later edits are outside this report.";
  const nextStep =
    assessment.kind === "bug" && assessment.bugAssessment.status === "needs_information"
      ? "For the issue author: review and provide the missing information listed in the complete report."
      : assessment.kind === "bug" && assessment.bugAssessment.status === "needs_verification"
        ? "For repository maintainers: review the proposed validation steps in the complete report."
        : "For repository maintainers: review the complete report and its recommended next steps before taking action.";
  const disclosure = renderAutomaticReplyIdentity(report, identity);
  const content = [
    "## Investigation completed — summary only",
    renderer.text(conclusion),
    `**Summary:** ${renderer.summary()}`,
    `**Source scope:** ${scope}`,
    `**Recorded validation:** ${report.validation.checks.length} checks; ${report.validation.checks.filter((check) => check.status === "passed").length} passed.`,
    `**Next action:** ${nextStep}`,
    "The full report is not embedded because it exceeds the supported comment size. The complete report is available to authorized repository operators in the Dashboard. No findings have been presented as a complete list here.",
    report.context.workItem.kind === "pull_request"
      ? "Completion records the investigation outcome; it does not authorize approval or merging."
      : "Completion records the investigation outcome; any requested information or validation remains a follow-up action.",
  ].join("\n\n");
  return { identity: disclosure, content, body: `${disclosure}\n\n${content}` };
}

export function renderAutomaticReplySummary(
  report: InvestigationResultV1,
  identity: AutomaticReplyIdentity,
): string {
  return renderAutomaticReplySummaryParts(report, identity).body;
}
