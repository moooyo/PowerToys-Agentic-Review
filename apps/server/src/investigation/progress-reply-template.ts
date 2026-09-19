import type { InvestigationResultV1, InvestigationUsageSummary } from "@agentic-review/contracts";
import {
  type AutomaticReplyIdentity,
  type AutomaticReplyModelContext,
  type RenderedAutomaticReply,
  recordedE2eRerunNextStep,
  renderAutomaticReplyIdentity,
  renderReplyTokenUsage,
} from "./auto-reply-template.js";
import { InvestigationRequestError } from "./errors.js";

export const progressReplyTemplateTokens = {
  received: ["trigger", "updated_at"],
  started: ["trigger", "updated_at"],
  failed: ["trigger", "updated_at", "failure"],
  completed: ["trigger", "updated_at", "result"],
} as const;

export type ProgressReplyStage = keyof typeof progressReplyTemplateTokens;
export type ProgressReplyTemplates = Readonly<Record<ProgressReplyStage, string>>;
export const progressReplyOptionalTemplateTokens = ["status", "usage"] as const;

export type ProgressReplyStatus =
  | "received"
  | "preparing"
  | "queued"
  | "running"
  | "blocked"
  | "interrupted"
  | "cancelled"
  | "failed"
  | "completed";

export interface ProgressReplyScope {
  readonly kind: "pull_request" | "issue";
  readonly headSha?: string;
  readonly currentHeadSha?: string;
  readonly snapshotCapturedAt?: string;
}

/** Values must come from accepted intake, Task, attempt, checkpoint, or sealed report records. */
export interface ProgressReplyContext {
  readonly mode?: "static" | "e2e";
  readonly status?: ProgressReplyStatus;
  readonly phase?: string;
  readonly attemptNumber?: number;
  readonly queuedForResume?: boolean;
  readonly scope?: ProgressReplyScope;
  readonly receivedAt?: string;
  readonly startedAt?: string;
  readonly trustedModels?: AutomaticReplyModelContext;
  readonly usage?: InvestigationUsageSummary;
  /** A fixed public instruction selected by the service, never a raw diagnostic. */
  readonly nextStep?: string;
}

export interface InvestigationProgressTrigger {
  readonly eventName: "issues" | "pull_request" | "issue_comment";
  readonly commandCommentId?: number;
  readonly actorUserId: number;
  readonly assigneeUserId: number;
  readonly actorLogin?: string;
  readonly assigneeLogin?: string;
}

export const defaultProgressReplyTemplates: ProgressReplyTemplates = Object.freeze({
  received: `## {{status}}

{{trigger}}

The assignment has been received for investigation. This comment will track its progress.

Last updated: {{updated_at}}
`,
  started: `## {{status}}

{{trigger}}

Work has started. This comment will be updated with the outcome.

Last updated: {{updated_at}}
`,
  failed: `## {{status}}

{{trigger}}

Last updated: {{updated_at}}

{{failure}}
`,
  completed: `## {{status}}

{{trigger}}

Last updated: {{updated_at}}

{{result}}
`,
});

/** E2E owns a separate comment and never inherits static-assignment instructions. */
export const defaultE2eProgressReplyTemplates: ProgressReplyTemplates = Object.freeze({
  received: `## {{status}}

{{trigger}}

The E2E request has been received. This separate comment tracks runtime verification and its screenshot or video evidence.

Last updated: {{updated_at}}
`,
  started: `## {{status}}

{{trigger}}

Runtime verification has started under the exclusive E2E execution lease. Results and evidence will be added to this comment.

Last updated: {{updated_at}}
`,
  failed: defaultProgressReplyTemplates.failed,
  completed: defaultProgressReplyTemplates.completed,
});

const legacyProgressReplyTemplates: ProgressReplyTemplates = {
  received: `## Investigation received\n\n{{trigger}}\n\nThe task has been queued and will begin as soon as a worker is available.\n\nLast updated: {{updated_at}}\n`,
  started: `## Investigation started\n\n{{trigger}}\n\nThe task is now running. This comment will be updated with the outcome.\n\nLast updated: {{updated_at}}\n`,
  failed: `## Investigation failed\n\n{{trigger}}\n\nLast updated: {{updated_at}}\n\n{{failure}}\n`,
  completed: `## Investigation completed\n\n{{trigger}}\n\nLast updated: {{updated_at}}\n\n{{result}}\n`,
};

function invalid(message: string): never {
  throw new InvestigationRequestError(400, "progress_reply_template_invalid", message);
}

/** Every stage keeps the trigger before the timestamp and its terminal outcome. */
export function validateProgressReplyTemplate(
  template: unknown,
  stage: ProgressReplyStage,
): string {
  if (!Object.hasOwn(progressReplyTemplateTokens, stage)) {
    return invalid("A progress reply requires a supported lifecycle stage.");
  }
  if (typeof template !== "string" || template.trim().length === 0) {
    return invalid("A progress reply template must be a non-empty string.");
  }
  // Only legacy built-in wording is normalized. Prepared deliveries never call this renderer again.
  const normalized =
    template.replaceAll("\r\n", "\n") === legacyProgressReplyTemplates[stage]
      ? defaultProgressReplyTemplates[stage]
      : template;
  if (Buffer.byteLength(normalized, "utf8") > 12_000) {
    return invalid("A progress reply template must not exceed 12000 UTF-8 bytes.");
  }
  if (/\{\{\{|\}\}\}/u.test(normalized)) {
    return invalid("Progress reply placeholders must use the exact {{token}} syntax.");
  }
  const tokens: readonly string[] = progressReplyTemplateTokens[stage];
  const found: string[] = [];
  const remaining = normalized.replace(/\{\{([^{}]*)\}\}/gu, (_, token: string) => {
    if (
      !tokens.includes(token) &&
      !progressReplyOptionalTemplateTokens.includes(token as "status" | "usage")
    )
      invalid(`Unknown progress reply token: ${token}.`);
    found.push(token);
    return "";
  });
  if (remaining.includes("{{") || remaining.includes("}}")) {
    return invalid("Progress reply placeholders must use the exact {{token}} syntax.");
  }
  for (const token of tokens) {
    if (found.filter((value) => value === token).length !== 1) {
      return invalid(`Progress reply token {{${token}}} must appear exactly once.`);
    }
  }
  for (const token of progressReplyOptionalTemplateTokens) {
    if (found.filter((value) => value === token).length > 1)
      return invalid(`The optional progress reply token {{${token}}} may appear only once.`);
  }
  if (found.includes("status") && found[0] !== "status") {
    return invalid("The optional status token must appear before the trigger token.");
  }
  if (
    found
      .filter((token) => token !== "status" && token !== "usage")
      .some((token, index) => token !== tokens[index])
  ) {
    return invalid(`Progress reply tokens must appear in the order ${tokens.join(", ")}.`);
  }
  return normalized;
}

function publicText(value: string, templateLiteral = false): string {
  const text = [...value.replace(/\r\n?/gu, "\n")]
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
    .join("")
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
    )
    .replace(
      /(?:agentic-review-progress|agentic-review-action|action-intent-binding):[A-Za-z0-9._:-]+/gu,
      "[publication marker omitted]",
    )
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/@/gu, "@\u200b")
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]*):(?=\/\/|[^\s]*@)/gu, "$1\u200b:")
    .replace(/\b(javascript|data|mailto):/giu, "$1\u200b:")
    .replace(/\bwww\./giu, "www\u200b.");
  return templateLiteral
    ? text.replace(/\\/gu, "\\\\").replace(/[[\]`~]/gu, "\\$&")
    : text
        .replace(/[\\`~*_{}[\]#!|]/gu, "\\$&")
        .replace(/^(\s*)([-+]|\d+[.)])(?=\s)/gmu, "$1\\$2")
        .trim();
}

function triggerText(trigger: InvestigationProgressTrigger): string {
  if (
    trigger === null ||
    typeof trigger !== "object" ||
    !["issues", "pull_request", "issue_comment"].includes(trigger.eventName) ||
    !Number.isSafeInteger(trigger.actorUserId) ||
    trigger.actorUserId < 1 ||
    !Number.isSafeInteger(trigger.assigneeUserId) ||
    trigger.assigneeUserId < 1 ||
    (trigger.eventName === "issue_comment" &&
      (!Number.isSafeInteger(trigger.commandCommentId) || trigger.commandCommentId! < 1))
  ) {
    return invalid(
      "A progress reply requires an exact assignment or E2E command trigger identity.",
    );
  }
  const user = (id: number, login: string | undefined): string =>
    typeof login === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?(?:\[bot\])?$/u.test(login)
      ? `GitHub user ${publicText(login)}`
      : `GitHub user ID ${id}`;
  if (trigger.eventName === "issue_comment")
    return `This E2E verification was requested by ${user(trigger.actorUserId, trigger.actorLogin)} in pull request comment ${trigger.commandCommentId}, mentioning ${user(trigger.assigneeUserId, trigger.assigneeLogin)} with the e2e command.`;
  const subject = trigger.eventName === "pull_request" ? "pull request" : "issue";
  const activity = trigger.eventName === "pull_request" ? "PR review" : "issue investigation";
  return `This ${activity} was triggered when ${user(trigger.actorUserId, trigger.actorLogin)} assigned the ${subject} to ${user(trigger.assigneeUserId, trigger.assigneeLogin)}.`;
}

export interface RenderProgressReplyInput {
  readonly stage: ProgressReplyStage;
  readonly template: string;
  readonly trigger: InvestigationProgressTrigger;
  readonly updatedAt: string;
  readonly identity: AutomaticReplyIdentity;
  readonly report?: InvestigationResultV1;
  readonly context?: ProgressReplyContext;
  /** A complete safe report, or an explicitly labeled safe summary when it cannot fit. */
  readonly result?: RenderedAutomaticReply;
  /** Generated only from durable, verified media publication receipts, never model prose. */
  readonly trustedMediaMarkdown?: string;
  /** A fixed, public failure description, never a raw exception or worker output. */
  readonly failure?: string;
}

const statusLabels: Record<ProgressReplyStatus, string> = {
  received: "received — preparing",
  preparing: "received — preparing",
  queued: "queued",
  running: "running",
  blocked: "waiting for action",
  interrupted: "interrupted",
  cancelled: "cancelled",
  failed: "failed",
  completed: "completed",
};

function isE2e(input: RenderProgressReplyInput): boolean {
  return input.context?.mode === "e2e" || input.trigger.eventName === "issue_comment";
}

function statusLabel(input: RenderProgressReplyInput, status: ProgressReplyStatus): string {
  const activity = isE2e(input)
    ? "E2E verification"
    : input.trigger.eventName === "issues"
      ? "Static investigation"
      : "Static review";
  const label =
    status === "queued" && input.context?.queuedForResume === true
      ? "queued for resume"
      : statusLabels[status];
  return `${activity} ${label}`;
}

const nextActions: Record<ProgressReplyStatus, string> = {
  received: "The service will capture the input snapshot for this investigation.",
  preparing: "The service will capture the input snapshot for this investigation.",
  queued: "An eligible worker must claim the queued task before work can begin.",
  running:
    "The worker will continue the recorded investigation. Its next meaningful change will update this comment.",
  blocked:
    "A repository operator must review the task in the Dashboard, resolve its recorded prerequisite, and explicitly resume it when available.",
  interrupted:
    "A repository operator must restore the required conditions and explicitly resume the task. It will not resume automatically.",
  cancelled:
    "No automatic continuation is scheduled. A repository operator can review the cancelled task in the Dashboard.",
  failed:
    "A repository operator must review the failure in the Dashboard and select an available recovery action. No automatic task retry is promised.",
  completed:
    "Repository maintainers can review the conclusion and recommended follow-up below. Completion does not authorize approval or merging.",
};

function timestamp(value: string): string {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed))
    return invalid("Progress context requires a valid recorded timestamp.");
  return new Date(parsed).toISOString();
}

function progressStatus(input: RenderProgressReplyInput): ProgressReplyStatus {
  const fallback = {
    received: "preparing",
    started: "running",
    failed: "failed",
    completed: "completed",
  } as const;
  const status = input.context?.status ?? fallback[input.stage];
  const allowed: Record<ProgressReplyStage, readonly ProgressReplyStatus[]> = {
    received: ["received", "preparing", "queued"],
    started: ["running"],
    failed: ["blocked", "interrupted", "cancelled", "failed"],
    completed: ["completed"],
  };
  if (!allowed[input.stage].includes(status)) {
    return invalid("The recorded investigation status does not match its narrative layout.");
  }
  return status;
}

/** Partial execution receipts are publishable progress, not a completed report conclusion. */
function partialE2eResults(input: RenderProgressReplyInput): string {
  const report = input.report;
  if (
    input.stage !== "failed" ||
    report?.context.task.kind !== "pr-e2e" ||
    report.report.completeness !== "partial" ||
    !["interrupted", "cancelled", "failed", "blocked"].includes(report.outcome)
  )
    return "";
  const lines = [
    "### Recorded E2E results",
    `**Task ${report.outcome}; partial E2E report.**`,
    report.report.loop.completedRounds === 0
      ? "Final analysis was not adopted. These records do not establish a completed E2E conclusion."
      : "The recorded feature outcomes do not establish a completed E2E conclusion.",
    report.report.loop.stopReason === "budget_exhausted"
      ? "The task exhausted its budget before completion."
      : "",
  ];
  const e2e = report.context.e2e;
  if (e2e === undefined) {
    const observations = report.verificationEvidence.filter(
      (entry) => entry.authority === "worker" && entry.provenance.taskId === report.context.task.id,
    ).length;
    const artifacts = report.artifacts.filter(
      (entry) => entry.taskId === report.context.task.id,
    ).length;
    lines.push(
      observations > 0 || artifacts > 0
        ? `Recorded ${observations} Worker observations and ${artifacts} artifacts. Final E2E feature results are unavailable.`
        : "No structured E2E feature results were recorded. Application execution is not established by this report.",
    );
  } else {
    const counts = (records: readonly { outcome: string }[]) =>
      (["passed", "failed", "blocked", "not_run"] as const)
        .map(
          (outcome) =>
            `${records.filter((entry) => entry.outcome === outcome).length} ${outcome.replaceAll("_", " ")}`,
        )
        .join(", ");
    const brief = (value: string) => {
      const safe = publicText(value).replace(/\s+/gu, " ");
      return safe.length <= 160 ? safe : `${safe.slice(0, 159)}…`;
    };
    const visible = e2e.features.slice(0, 8);
    lines.push(`Recorded features: ${counts(e2e.features)}.`);
    for (const feature of visible) {
      lines.push(
        [
          `- **${brief(feature.title)}:** recorded ${feature.outcome.replaceAll("_", " ")}. Assertions: ${counts(feature.assertions)}.`,
          ...feature.limitations
            .slice(0, 2)
            .map((limitation) => `  Limitation: ${brief(limitation)}`),
        ].join("\n"),
      );
    }
    lines.push(
      `Summary only: showing ${visible.length} of ${e2e.features.length} recorded features with bounded titles and limitations. Full assertions and limitations remain in the Dashboard report.`,
    );
  }
  return lines.filter(Boolean).join("\n\n");
}

function sourceScope(input: RenderProgressReplyInput): string {
  const workItemKind = input.trigger.eventName === "issues" ? "issue" : "pull_request";
  const subject = input.report?.context.subjects.find(
    (item) => item.id === input.report?.context.task.subjectRef,
  );
  const reportHead = subject?.kind === "original_pr" ? subject.headSha : undefined;
  const scope = input.context?.scope;
  if (scope !== undefined && scope.kind !== workItemKind) {
    return invalid("The recorded source scope does not match the assignment target kind.");
  }
  if (input.report !== undefined && input.report.context.workItem.kind !== workItemKind) {
    return invalid("The recorded report does not match the assignment target kind.");
  }
  if (workItemKind === "issue") {
    return scope?.snapshotCapturedAt === undefined
      ? input.stage === "received" &&
        [undefined, "received", "preparing"].includes(input.context?.status)
        ? "Issue input is being prepared; the investigation snapshot has not been captured yet."
        : "The issue text and discussion snapshot recorded for this investigation. Later edits are outside this scope."
      : `Issue text and discussion snapshot captured at ${timestamp(scope.snapshotCapturedAt)}. Later edits are outside this scope.`;
  }
  const head = scope?.headSha ?? reportHead;
  if (reportHead !== undefined && scope?.headSha !== undefined && reportHead !== scope.headSha) {
    return invalid("The progress scope does not match the commit reviewed in the sealed report.");
  }
  for (const sha of [head, scope?.currentHeadSha]) {
    if (
      sha !== undefined &&
      (typeof sha !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha))
    ) {
      return invalid("Progress source scope requires an exact recorded commit identity.");
    }
  }
  if (head === undefined)
    return "The pull request input; a reviewed commit has not been established in this update.";
  const preparing =
    input.stage === "received" &&
    [undefined, "received", "preparing"].includes(input.context?.status);
  return (
    (preparing
      ? `${isE2e(input) ? "Requested" : "Assigned"} pull request revision ${head}; ${isE2e(input) ? "E2E verification" : "investigation"} input is still being prepared.`
      : `Pull request snapshot at commit ${head}.`) +
    (scope?.currentHeadSha !== undefined && scope.currentHeadSha !== head
      ? ` The current pull request head is ${scope.currentHeadSha}; this investigation does not cover that newer head.`
      : " Later pushes are outside this scope.")
  );
}

function statusCard(input: RenderProgressReplyInput, status: ProgressReplyStatus): string {
  const context = input.context;
  if (
    context?.attemptNumber !== undefined &&
    (!Number.isSafeInteger(context.attemptNumber) || context.attemptNumber < 1)
  ) {
    return invalid("Progress context requires a positive recorded attempt number.");
  }
  const label = statusLabel(input, status);
  const nextStep =
    (["blocked", "failed"].includes(status) ? recordedE2eRerunNextStep(input.report) : undefined) ??
    context?.nextStep ??
    nextActions[status];
  return [
    `**Status:** ${label}`,
    `**Source scope:** ${sourceScope(input)}`,
    context?.attemptNumber === undefined ? "" : `**Attempt:** ${context.attemptNumber}`,
    context?.phase === undefined ? "" : `**Recorded phase:** ${publicText(context.phase)}`,
    context?.receivedAt === undefined ? "" : `**Received:** ${timestamp(context.receivedAt)}`,
    context?.startedAt === undefined ? "" : `**First started:** ${timestamp(context.startedAt)}`,
    input.template.includes("{{usage}}") || input.result !== undefined
      ? ""
      : renderReplyTokenUsage(context?.usage, input.report),
    `**Next action:** ${publicText(nextStep)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The outbox owns the stable comment marker and the final transport size limit. */
export function renderProgressReply(input: RenderProgressReplyInput): string {
  const template = validateProgressReplyTemplate(input.template, input.stage);
  const updatedAt = typeof input.updatedAt === "string" ? Date.parse(input.updatedAt) : Number.NaN;
  if (!Number.isFinite(updatedAt)) return invalid("A progress reply requires a valid timestamp.");
  if (
    (input.stage === "completed" && input.result === undefined) ||
    (input.result !== undefined &&
      (input.result === null ||
        typeof input.result !== "object" ||
        typeof input.result.content !== "string" ||
        !input.result.content.trim()))
  ) {
    return invalid("A completed progress reply requires the full rendered report.");
  }
  if (input.stage === "failed" && (typeof input.failure !== "string" || !input.failure.trim())) {
    return invalid("A failed progress reply requires a public failure description.");
  }
  const status = progressStatus(input);
  const identity = renderAutomaticReplyIdentity(
    input.report,
    input.identity,
    input.context?.trustedModels,
  );
  if (
    input.result !== undefined &&
    (input.result.identity !== identity ||
      input.result.body !== `${identity}\n\n${input.result.content}`)
  ) {
    return invalid(
      "The result must retain the exact verified identity and structured report body.",
    );
  }
  const values: Record<string, string> = {
    status: statusLabel(input, status),
    trigger: triggerText(input.trigger),
    updated_at: new Date(updatedAt).toISOString(),
    failure: input.failure === undefined ? "" : publicText(input.failure),
    result: input.result?.content ?? "",
    usage: renderReplyTokenUsage(input.context?.usage, input.report),
  };
  let offset = 0;
  let result = "";
  for (const match of template.matchAll(/\{\{([^{}]*)\}\}/gu)) {
    result += publicText(template.slice(offset, match.index), true);
    result += values[match[1] ?? ""] ?? "";
    offset = match.index + match[0].length;
  }
  return [
    identity,
    statusCard(input, status),
    `${result}${publicText(template.slice(offset), true)}`.trim(),
    partialE2eResults(input),
    input.trustedMediaMarkdown ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
