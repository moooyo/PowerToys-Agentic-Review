import { createHash } from "node:crypto";
import type {
  ActionContextV1,
  InvestigationActionIntentV1,
  InvestigationActionKind,
  InvestigationSubjectV1,
} from "@agentic-review/contracts";
import { contentDigest } from "./integrity.js";
import type {
  InvestigationActionTransport,
  InvestigationCommentTarget,
  InvestigationGitHubIdentity,
  InvestigationOperatorPrincipal,
  InvestigationProgressCommentDelivery,
  InvestigationProgressCommentRequest,
  InvestigationProgressCommentTransport,
  InvestigationRepositoryRecord,
  InvestigationWorkItemRecord,
} from "./types.js";

type Json = Record<string, unknown>;
type Delivery = Awaited<ReturnType<InvestigationActionTransport["execute"]>>;
type ProgressDelivery = InvestigationProgressCommentDelivery & {
  readonly effect: "not_sent" | "rejected" | "applied" | "unknown";
  readonly retryable: boolean;
  readonly reasonCode: string;
};
type RemoteRequest = { method: "POST" | "PATCH" | "PUT"; path: string; body: Json };

export interface InvestigationGitHubTransportOptions {
  readonly token: string;
  readonly expectedGitHubUserId: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
  readonly resolveSubject?: (
    id: string,
    repositoryId: string,
    workItemId: string,
  ) => Promise<InvestigationSubjectV1 | null>;
}

class GitHubActionFailure extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
    readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = "GitHubActionFailure";
  }
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const hasControlCharacters = (value: string): boolean => {
  for (const character of value) if (character.charCodeAt(0) < 32) return true;
  return false;
};
const object = (value: unknown): Json => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new GitHubActionFailure("invalid_github_response");
  return value as Json;
};
const positiveId = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new GitHubActionFailure("invalid_github_identity");
  return Number(value);
};
const githubLogin = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?(?:\[bot\])?$/u.test(value)
  )
    throw new GitHubActionFailure("invalid_github_login");
  return value;
};
const sha = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value))
    throw new GitHubActionFailure("invalid_github_revision");
  return value;
};
const repositoryPath = (repository: InvestigationRepositoryRecord): string => {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository.fullName))
    throw new GitHubActionFailure("invalid_repository_name");
  return `/repos/${repository.fullName.split("/").map(encodeURIComponent).join("/")}`;
};
const marker = (intent: InvestigationActionIntentV1): string =>
  `<!-- agentic-review-action:${intent.id}:${intent.payloadDigest} -->`;
const messageBody = (intent: InvestigationActionIntentV1): string => {
  if (intent.payload.kind !== "feedback") throw new GitHubActionFailure("invalid_feedback_payload");
  const body = [
    intent.payload.body,
    ...intent.payload.drafts
      .filter((draft) => draft.suggestion === null)
      .map((draft) => draft.body),
    marker(intent),
  ]
    .filter(Boolean)
    .join("\n\n");
  if (Buffer.byteLength(body, "utf8") > 60_000)
    throw new GitHubActionFailure("feedback_requires_smaller_explicit_payload");
  return body;
};
const delivery = (
  state: Delivery["state"],
  message: string,
  externalId: string | null = null,
): Delivery => ({ state, message, externalId });

const progressDelivery = (
  state: ProgressDelivery["state"],
  effect: ProgressDelivery["effect"],
  retryable: boolean,
  reasonCode: string,
  message: string,
  externalId: string | null = null,
  retryAfterMs?: number,
): ProgressDelivery => ({
  state,
  effect,
  retryable,
  reasonCode,
  message,
  externalId,
  ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
});

const retryDelay = (headers: Headers): number | undefined => {
  const value = headers.get("retry-after");
  if (value !== null) {
    const delay = /^\d+(?:\.\d+)?$/u.test(value.trim())
      ? Math.ceil(Number(value) * 1_000)
      : Date.parse(value) - Date.now();
    if (Number.isSafeInteger(delay)) return Math.max(0, delay);
  }
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = headers.get("x-ratelimit-reset");
    if (reset !== null && /^\d+$/u.test(reset)) {
      const delay = Number(reset) * 1_000 - Date.now();
      if (Number.isSafeInteger(delay)) return Math.max(0, delay);
    }
  }
  return undefined;
};

const progressFailureReason = (error: unknown): string => {
  if (!(error instanceof GitHubActionFailure)) return "github_read_failed";
  if (error.code === "progress_comment_missing") return "comment_missing";
  if (error.code.startsWith("progress_comment_"))
    return `conflict_${error.code.slice("progress_".length)}`;
  if (error.code === "github_request_rejected" && error.status !== null)
    return `github_http_${error.status}`;
  return error.code;
};

const transientProgressReadFailure = (error: unknown): boolean => {
  if (!(error instanceof GitHubActionFailure)) return true;
  if (error.code === "github_rate_limited") return true;
  if (error.status !== null) return error.status === 408 || error.status >= 500;
  return [
    "invalid_github_response",
    "missing_github_response",
    "github_response_too_large",
    "invalid_reconciliation_response",
  ].includes(error.code);
};

const progressRequest = (
  request: InvestigationProgressCommentRequest,
): InvestigationProgressCommentRequest => {
  const frozen = {
    marker: request.marker,
    body: request.body,
    externalId: request.externalId,
    previousBody: request.previousBody,
    ...(request.expectedAssigneeUserId === undefined
      ? {}
      : { expectedAssigneeUserId: positiveId(request.expectedAssigneeUserId) }),
    ...(request.expectedReviewerUserId === undefined
      ? {}
      : { expectedReviewerUserId: positiveId(request.expectedReviewerUserId) }),
  };
  if (
    typeof frozen.marker !== "string" ||
    !(
      /^<!-- agentic-review-progress:[A-Za-z0-9][A-Za-z0-9._:-]{0,199} -->$/u.test(frozen.marker) ||
      (frozen.externalId !== null &&
        /^<!-- agentic-review-action:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}:[a-f0-9]{64} -->$/u.test(
          frozen.marker,
        ))
    )
  )
    throw new GitHubActionFailure("invalid_progress_comment_marker");
  for (const body of [
    frozen.body,
    ...(frozen.previousBody === null ? [] : [frozen.previousBody]),
  ]) {
    if (
      typeof body !== "string" ||
      Buffer.byteLength(body, "utf8") > 60_000 ||
      body.split(frozen.marker).length !== 2 ||
      (body.match(/<!-- agentic-review-(?:progress|action):/gu) ?? []).length !== 1
    )
      throw new GitHubActionFailure("invalid_progress_comment_body");
  }
  if (frozen.externalId === null) {
    if (frozen.previousBody !== null)
      throw new GitHubActionFailure("invalid_progress_comment_create");
  } else {
    if (
      typeof frozen.externalId !== "string" ||
      !/^[1-9][0-9]*$/u.test(frozen.externalId) ||
      frozen.previousBody === null
    )
      throw new GitHubActionFailure("invalid_progress_comment_update");
    positiveId(Number(frozen.externalId));
  }
  return frozen;
};

/** The transport performs one mutation at most; ambiguous delivery is only reconciled with GETs. */
export class InvestigationGitHubTransport
  implements InvestigationActionTransport, InvestigationProgressCommentTransport
{
  readonly supportedActions: readonly InvestigationActionKind[] = [
    "comment",
    "approve",
    "suggestion-comment",
    "request-changes",
    "close",
    "merge",
    "trigger-ci",
    "close-as-duplicate",
    "create-pr",
  ];
  private readonly requestFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: InvestigationGitHubTransportOptions) {
    if (
      !options.token ||
      /[\r\n]/u.test(options.token) ||
      !Number.isSafeInteger(options.expectedGitHubUserId) ||
      options.expectedGitHubUserId < 1
    )
      throw new TypeError("A GitHub token and expected numeric publisher identity are required.");
    this.timeoutMs = options.requestTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000)
      throw new TypeError("The GitHub request timeout must be between 1 and 60000 milliseconds.");
    this.requestFetch = options.fetch ?? globalThis.fetch;
  }

  async readPublisherIdentity(): Promise<InvestigationGitHubIdentity> {
    const user = object((await this.request("/user")).value);
    const githubUserId = positiveId(user.id);
    if (githubUserId !== this.options.expectedGitHubUserId)
      throw new GitHubActionFailure("publisher_identity_changed");
    return { githubUserId, githubLogin: githubLogin(user.login) };
  }

  async readTarget(
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationWorkItemRecord,
    actor: InvestigationOperatorPrincipal,
  ): Promise<ActionContextV1["target"]> {
    const { value } = await this.preflightIdentity(repository, workItem, actor);
    return this.targetFrom(value, workItem);
  }

  async readCapabilities(
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationWorkItemRecord,
    actor: InvestigationOperatorPrincipal,
  ): Promise<readonly InvestigationActionKind[]> {
    const remote = await this.preflightIdentity(repository, workItem, actor);
    return this.supportedActions.filter((action) => {
      if (!actor.actionCapabilities.includes(action)) return false;
      if (
        workItem.kind === "issue" &&
        ["approve", "request-changes", "suggestion-comment", "merge", "trigger-ci"].includes(action)
      )
        return false;
      if (workItem.kind === "pull_request" && action === "close-as-duplicate") return false;
      try {
        this.assertRemotePermission(
          { action } as InvestigationActionIntentV1,
          remote.repository,
          remote.value,
        );
        return true;
      } catch {
        return false;
      }
    });
  }

  async publishProgressComment(
    request: InvestigationProgressCommentRequest,
    repositoryInput: InvestigationRepositoryRecord,
    workItemInput: InvestigationCommentTarget,
    actor: InvestigationOperatorPrincipal,
    beforeDispatch?: () => void,
  ): Promise<ProgressDelivery> {
    const repository = { ...repositoryInput };
    const workItem = { ...workItemInput };
    let frozen: InvestigationProgressCommentRequest | undefined;
    let mutation: RemoteRequest;
    let checkingDispatchGuard = false;
    try {
      frozen = progressRequest(request);
      this.assertProgressAuthority(repository, workItem, actor);
      const base = repositoryPath(repository);
      mutation = {
        method: frozen.externalId === null ? "POST" : "PATCH",
        path:
          frozen.externalId === null
            ? `${base}/issues/${workItem.number}/comments`
            : `${base}/issues/comments/${frozen.externalId}`,
        body: { body: frozen.body },
      };
      let alreadyPublished = false;
      if (frozen.externalId !== null) {
        const existing = await this.readProgressComment(mutation.path);
        this.assertProgressComment(existing, frozen, repository, workItem, true);
        alreadyPublished = existing.body === frozen.body;
      }
      const remote = await this.preflightIdentity(repository, workItem, actor);
      this.assertProgressAuthority(repository, workItem, actor);
      this.assertRemotePermission({ action: "comment" }, remote.repository, remote.value);
      if (
        frozen.externalId === null &&
        frozen.expectedAssigneeUserId !== undefined &&
        (!Array.isArray(remote.value.assignees) ||
          !remote.value.assignees.some(
            (assignee) => object(assignee).id === frozen?.expectedAssigneeUserId,
          ))
      )
        throw new GitHubActionFailure("assignment_not_current");
      if (
        frozen.externalId === null &&
        frozen.expectedReviewerUserId !== undefined &&
        (workItem.kind !== "pull_request" ||
          !Array.isArray(remote.value.requested_reviewers) ||
          !remote.value.requested_reviewers.some(
            (reviewer) =>
              object(reviewer).id === frozen?.expectedReviewerUserId &&
              object(reviewer).type === "User",
          ))
      )
        throw new GitHubActionFailure("review_request_not_current");
      if (alreadyPublished)
        return progressDelivery(
          "succeeded",
          "applied",
          false,
          "comment_already_applied",
          "The exact progress comment update is already present.",
          frozen.externalId,
        );
      checkingDispatchGuard = true;
      beforeDispatch?.();
    } catch (error) {
      return progressDelivery(
        "failed",
        "not_sent",
        !checkingDispatchGuard && transientProgressReadFailure(error),
        checkingDispatchGuard ? "dispatch_guard_rejected" : progressFailureReason(error),
        this.failureMessage(error),
        frozen?.externalId ?? null,
        error instanceof GitHubActionFailure ? error.retryAfterMs : undefined,
      );
    }
    try {
      const response = await this.request(mutation.path, mutation.method, mutation.body);
      const comment = object(response.value);
      this.assertProgressComment(comment, frozen, repository, workItem, false);
      return progressDelivery(
        "succeeded",
        "applied",
        false,
        frozen.externalId === null ? "comment_created" : "comment_updated",
        "GitHub acknowledged the exact progress comment.",
        String(positiveId(comment.id)),
      );
    } catch (error) {
      if (
        error instanceof GitHubActionFailure &&
        error.status !== null &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      )
        return progressDelivery(
          "failed",
          "rejected",
          error.code === "github_rate_limited",
          (error.status === 404 || error.status === 410) && frozen.externalId !== null
            ? "comment_missing"
            : progressFailureReason(error),
          this.failureMessage(error),
          frozen.externalId,
          error.retryAfterMs,
        );
      return progressDelivery(
        "unknown",
        "unknown",
        false,
        error instanceof GitHubActionFailure && error.status === null
          ? "mutation_receipt_unverified"
          : "mutation_response_unknown",
        "The progress request may have reached GitHub. Reconcile it before any further submission.",
        frozen.externalId,
        error instanceof GitHubActionFailure ? error.retryAfterMs : undefined,
      );
    }
  }

  async reconcileProgressComment(
    request: InvestigationProgressCommentRequest,
    repositoryInput: InvestigationRepositoryRecord,
    workItemInput: InvestigationCommentTarget,
    actor: InvestigationOperatorPrincipal,
  ): Promise<ProgressDelivery> {
    const repository = { ...repositoryInput };
    const workItem = { ...workItemInput };
    let frozen: InvestigationProgressCommentRequest | undefined;
    try {
      frozen = progressRequest(request);
      this.assertProgressAuthority(repository, workItem, actor);
      const remote = await this.preflightIdentity(repository, workItem, actor);
      this.assertProgressAuthority(repository, workItem, actor);
      this.assertRemotePermission({ action: "comment" }, remote.repository, remote.value);
      const base = repositoryPath(repository);
      if (frozen.externalId !== null) {
        const comment = await this.readProgressComment(
          `${base}/issues/comments/${frozen.externalId}`,
        );
        this.assertProgressComment(comment, frozen, repository, workItem, true);
        if (comment.body !== frozen.body)
          return progressDelivery(
            "unknown",
            "unknown",
            true,
            "previous_body_observed",
            "The previous progress body is still visible; this does not authorize a resend.",
            frozen.externalId,
          );
        return progressDelivery(
          "succeeded",
          "applied",
          false,
          "comment_reconciled",
          "Read-only reconciliation found the exact progress comment update.",
          frozen.externalId,
        );
      }
      let match: Json | undefined;
      for (let page = 1; page <= 100; page += 1) {
        const response = await this.request(
          `${base}/issues/${workItem.number}/comments?per_page=100&page=${page}`,
        );
        if (!Array.isArray(response.value))
          throw new GitHubActionFailure("invalid_reconciliation_response");
        for (const entry of response.value) {
          const comment = object(entry);
          if (typeof comment.body !== "string" || !comment.body.includes(frozen.marker)) continue;
          if (match !== undefined)
            return progressDelivery(
              "unknown",
              "unknown",
              false,
              "conflict_multiple_comments",
              "Multiple matching progress comments need manual reconciliation.",
            );
          match = comment;
        }
        if (response.value.length < 100) {
          if (match !== undefined) {
            this.assertProgressComment(match, frozen, repository, workItem, false);
            return progressDelivery(
              "succeeded",
              "applied",
              false,
              "comment_reconciled",
              "Read-only reconciliation found the exact progress comment.",
              String(positiveId(match.id)),
            );
          }
          return progressDelivery(
            "unknown",
            "unknown",
            true,
            "comment_not_observed",
            "No exact progress comment was found; absence does not authorize a resend.",
          );
        }
      }
      return progressDelivery(
        "unknown",
        "unknown",
        true,
        "reconciliation_incomplete",
        "Progress reconciliation reached its page budget without a complete result.",
      );
    } catch (error) {
      return progressDelivery(
        "unknown",
        "unknown",
        transientProgressReadFailure(error),
        progressFailureReason(error),
        this.failureMessage(error),
        frozen?.externalId ?? null,
        error instanceof GitHubActionFailure ? error.retryAfterMs : undefined,
      );
    }
  }

  private async readProgressComment(path: string): Promise<Json> {
    try {
      return object((await this.request(path)).value);
    } catch (error) {
      if (error instanceof GitHubActionFailure && (error.status === 404 || error.status === 410))
        throw new GitHubActionFailure("progress_comment_missing", error.status);
      throw error;
    }
  }

  private assertProgressAuthority(
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationCommentTarget,
    actor: InvestigationOperatorPrincipal,
  ): void {
    positiveId(workItem.number);
    if (workItem.githubWorkItemId !== undefined) positiveId(workItem.githubWorkItemId);
    if (workItem.repositoryId !== repository.id || !actor.repositoryIds.includes(repository.id))
      throw new GitHubActionFailure("repository_scope_denied");
    if (!actor.actionCapabilities.includes("comment"))
      throw new GitHubActionFailure("action_permission_denied");
  }

  private assertProgressComment(
    comment: Json,
    request: InvestigationProgressCommentRequest,
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationCommentTarget,
    allowPreviousBody: boolean,
  ): void {
    const id = String(positiveId(comment.id));
    if (request.externalId !== null && id !== request.externalId)
      throw new GitHubActionFailure("progress_comment_identity_changed");
    if (positiveId(object(comment.user).id) !== this.options.expectedGitHubUserId)
      throw new GitHubActionFailure("progress_comment_owner_changed");
    if (
      typeof comment.issue_url !== "string" ||
      comment.issue_url.toLowerCase() !==
        `https://api.github.com${repositoryPath(repository)}/issues/${workItem.number}`.toLowerCase()
    )
      throw new GitHubActionFailure("progress_comment_target_changed");
    if (
      typeof comment.body !== "string" ||
      comment.body.split(request.marker).length !== 2 ||
      (comment.body.match(/<!-- agentic-review-(?:progress|action):/gu) ?? []).length !== 1
    )
      throw new GitHubActionFailure("progress_comment_marker_changed");
    if (
      comment.body !== request.body &&
      !(allowPreviousBody && comment.body === request.previousBody)
    )
      throw new GitHubActionFailure("progress_comment_body_changed");
  }

  async validateRemoteBranch(
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationWorkItemRecord,
    subject: InvestigationSubjectV1,
    actor: InvestigationOperatorPrincipal,
    baseBranch?: string,
  ): Promise<void> {
    await this.preflightIdentity(repository, workItem, actor);
    if (
      subject.kind !== "remote_branch" ||
      subject.repositoryId !== repository.id ||
      subject.workItemId !== workItem.id
    )
      throw new GitHubActionFailure("verified_remote_branch_required");
    await this.checkBranch(repository, subject, baseBranch);
  }

  async validateSuggestions(
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationWorkItemRecord,
    intent: InvestigationActionIntentV1,
  ): Promise<void> {
    if (intent.payload.kind !== "feedback") return;
    messageBody(intent);
    const suggestions = intent.payload.drafts.flatMap((draft) =>
      draft.suggestion ? [draft.suggestion] : [],
    );
    if (suggestions.length > 100)
      throw new GitHubActionFailure("feedback_requires_smaller_explicit_payload");
    for (const draft of intent.payload.drafts) {
      if (draft.suggestion === null) continue;
      if (draft.suggestion.replacement.includes("```"))
        throw new GitHubActionFailure("unsafe_suggestion_fence");
      if (
        Buffer.byteLength(draft.body, "utf8") +
          Buffer.byteLength(draft.suggestion.replacement, "utf8") +
          20 >
        60_000
      )
        throw new GitHubActionFailure("suggestion_too_large");
    }
    if (suggestions.length === 0) {
      if (intent.action === "suggestion-comment")
        throw new GitHubActionFailure("suggestion_required");
      return;
    }
    if (workItem.kind !== "pull_request" || intent.expectedHeadSha === null)
      throw new GitHubActionFailure("suggestion_requires_pull_request_revision");
    const patches = new Map<string, string>();
    const wantedPaths = new Set(suggestions.map((suggestion) => suggestion.path));
    for (let page = 1; page <= 100 && patches.size < wantedPaths.size; page += 1) {
      const response = await this.request(
        `${repositoryPath(repository)}/pulls/${workItem.number}/files?per_page=100&page=${page}`,
      );
      if (!Array.isArray(response.value))
        throw new GitHubActionFailure("invalid_pull_request_diff");
      for (const value of response.value) {
        const file = object(value);
        if (
          typeof file.filename === "string" &&
          wantedPaths.has(file.filename) &&
          typeof file.patch === "string"
        )
          patches.set(file.filename, file.patch);
      }
      if (response.value.length < 100) break;
    }
    const ranges = new Map<string, Array<[number, number]>>();
    for (const suggestion of suggestions) {
      if (
        suggestion.headSha !== intent.expectedHeadSha ||
        suggestion.subjectRef !== intent.subjectRef
      )
        throw new GitHubActionFailure("suggestion_source_mismatch");
      if (
        !suggestion.path ||
        suggestion.path.includes("\\") ||
        suggestion.path.startsWith("/") ||
        suggestion.path.split("/").some((part) => part === ".." || part === ".") ||
        suggestion.path.includes(":") ||
        hasControlCharacters(suggestion.path)
      )
        throw new GitHubActionFailure("invalid_suggestion_path");
      if (suggestion.startLine < 1 || suggestion.endLine < suggestion.startLine)
        throw new GitHubActionFailure("invalid_suggestion_range");
      const patch = patches.get(suggestion.path);
      const inDiff =
        patch !== undefined &&
        [...patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)].some((hunk) => {
          const start = Number(hunk[1]);
          const count = Number(hunk[2] ?? 1);
          return count > 0 && suggestion.startLine >= start && suggestion.endLine < start + count;
        });
      if (!inDiff) throw new GitHubActionFailure("suggestion_outside_available_diff");
      const previous = ranges.get(suggestion.path) ?? [];
      if (
        previous.some(([start, end]) => start <= suggestion.endLine && suggestion.startLine <= end)
      )
        throw new GitHubActionFailure("overlapping_suggestions");
      previous.push([suggestion.startLine, suggestion.endLine]);
      ranges.set(suggestion.path, previous);
      const response = object(
        (
          await this.request(
            `${repositoryPath(repository)}/contents/${suggestion.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(intent.expectedHeadSha)}`,
          )
        ).value,
      );
      if (
        response.type !== "file" ||
        response.encoding !== "base64" ||
        typeof response.content !== "string"
      )
        throw new GitHubActionFailure("suggestion_original_content_unavailable");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(response.content.replace(/\s/gu, ""), "base64"),
      );
      const lines = content.split(/\r?\n/u);
      if (
        suggestion.endLine > lines.length ||
        digest(lines.slice(suggestion.startLine - 1, suggestion.endLine).join("\n")) !==
          suggestion.originalContentDigest
      )
        throw new GitHubActionFailure("suggestion_original_content_changed");
    }
  }

  async execute(
    intent: InvestigationActionIntentV1,
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationWorkItemRecord,
    actor: InvestigationOperatorPrincipal,
    beforeDispatch?: () => void,
  ): Promise<Delivery> {
    let request: RemoteRequest;
    try {
      if (intent.state !== "confirmed" && intent.state !== "executing")
        throw new GitHubActionFailure("action_not_confirmed_for_execution");
      this.assertIntent(intent, repository, workItem, actor);
      const remote = await this.preflightIdentity(repository, workItem, actor);
      const target = this.targetFrom(remote.value, workItem);
      if (
        target.revisionKey !== intent.expectedRevisionKey ||
        target.headSha !== intent.expectedHeadSha
      )
        return delivery("failed", "The target revision changed. Prepare and confirm a new action.");
      if (target.state !== "open") return delivery("failed", "The target is no longer open.");
      this.assertRemotePermission(intent, remote.repository, remote.value);
      await this.validateSuggestions(repository, workItem, intent);
      request = await this.prepareRequest(intent, repository, workItem);
      const current = await this.readTarget(repository, workItem, actor);
      if (
        current.state !== "open" ||
        current.revisionKey !== intent.expectedRevisionKey ||
        current.headSha !== intent.expectedHeadSha
      )
        return delivery(
          "failed",
          "The target changed while preparing the action. Refresh the preview before sending.",
        );
      beforeDispatch?.();
    } catch (error) {
      return delivery("failed", this.failureMessage(error));
    }
    try {
      const response = await this.request(request.path, request.method, request.body);
      const value = response.value === null ? null : object(response.value);
      if (intent.action === "trigger-ci" && response.status === 204)
        return delivery(
          "succeeded",
          "GitHub acknowledged the workflow dispatch; no run identifier was returned.",
        );
      if (intent.action === "merge") {
        if (value?.merged !== true)
          return delivery("failed", "GitHub did not merge the pull request.");
        return delivery("succeeded", "GitHub confirmed the merge.", sha(value.sha));
      }
      if (value === null) throw new GitHubActionFailure("missing_github_receipt");
      const externalId = value.id ?? value.workflow_run_id;
      positiveId(externalId);
      if (intent.action === "close" || intent.action === "close-as-duplicate") {
        if (value.state !== "closed") throw new GitHubActionFailure("invalid_close_receipt");
        if (intent.action === "close-as-duplicate" && value.state_reason !== "duplicate")
          throw new GitHubActionFailure("invalid_duplicate_receipt");
      }
      if (["approve", "request-changes", "suggestion-comment"].includes(intent.action)) {
        const expectedState =
          intent.action === "approve"
            ? "APPROVED"
            : intent.action === "request-changes"
              ? "CHANGES_REQUESTED"
              : "COMMENTED";
        if (
          value.state !== expectedState ||
          value.commit_id !== intent.expectedHeadSha ||
          positiveId(object(value.user).id) !== this.options.expectedGitHubUserId ||
          value.body !== request.body.body
        )
          throw new GitHubActionFailure("invalid_review_receipt");
      }
      if (
        intent.action === "comment" &&
        (value.body !== request.body.body ||
          positiveId(object(value.user).id) !== this.options.expectedGitHubUserId)
      )
        throw new GitHubActionFailure("invalid_comment_receipt");
      return delivery("succeeded", "GitHub acknowledged the confirmed action.", String(externalId));
    } catch (error) {
      if (
        error instanceof GitHubActionFailure &&
        error.status !== null &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      )
        return delivery("failed", this.failureMessage(error));
      return delivery(
        "unknown",
        "The request may have reached GitHub. Reconcile it before any further submission.",
      );
    }
  }

  async reconcile(
    intent: InvestigationActionIntentV1,
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationWorkItemRecord,
    actor: InvestigationOperatorPrincipal,
  ): Promise<Delivery> {
    try {
      this.assertIntent(intent, repository, workItem, actor);
      const remote = await this.preflightIdentity(repository, workItem, actor);
      const base = repositoryPath(repository);
      if (intent.action === "merge") {
        if (
          remote.value.merged === true &&
          object(remote.value.head).sha === intent.expectedHeadSha
        )
          return delivery(
            "succeeded",
            "The expected pull request revision is merged.",
            sha(remote.value.merge_commit_sha),
          );
        return delivery(
          "unknown",
          "The expected merge cannot be established; no mutation was retried.",
        );
      }
      if (intent.action === "close" || intent.action === "close-as-duplicate") {
        // A closed state alone cannot prove that this actor's ambiguous request performed it.
        return delivery(
          "unknown",
          "Inspect the target's closure audit before resolving this uncertain action; no mutation was retried.",
        );
      }
      if (intent.action === "trigger-ci")
        return delivery(
          "unknown",
          "Workflow dispatch has no universal idempotency key. Inspect the run history; no dispatch was repeated.",
        );
      const isReview = ["approve", "request-changes", "suggestion-comment"].includes(intent.action);
      const path =
        intent.action === "create-pr"
          ? `${base}/pulls?state=all`
          : isReview
            ? `${base}/pulls/${workItem.number}/reviews?`
            : `${base}/issues/${workItem.number}/comments?`;
      let match: Json | undefined;
      for (let page = 1; page <= 100; page += 1) {
        const response = await this.request(
          `${path}${path.endsWith("?") ? "" : "&"}per_page=100&page=${page}`,
        );
        if (!Array.isArray(response.value))
          throw new GitHubActionFailure("invalid_reconciliation_response");
        for (const entry of response.value) {
          const candidate = object(entry);
          if (typeof candidate.body !== "string" || !candidate.body.includes(marker(intent)))
            continue;
          if (positiveId(object(candidate.user).id) !== this.options.expectedGitHubUserId) continue;
          if (isReview && candidate.commit_id !== intent.expectedHeadSha) continue;
          if (match !== undefined)
            return delivery(
              "unknown",
              "Multiple matching remote records need manual reconciliation.",
            );
          match = candidate;
        }
        if (response.value.length < 100) {
          if (!match)
            return delivery(
              "unknown",
              "No matching receipt was found; absence does not authorize a resend.",
            );
          const request = await this.prepareRequest(intent, repository, workItem);
          if (match.body !== request.body.body)
            return delivery(
              "unknown",
              "The matching remote body differs from the confirmed payload.",
            );
          if (isReview) {
            const expected =
              intent.action === "approve"
                ? "APPROVED"
                : intent.action === "request-changes"
                  ? "CHANGES_REQUESTED"
                  : "COMMENTED";
            if (match.state !== expected)
              return delivery(
                "unknown",
                "The review disposition differs from the confirmed action.",
              );
            if (intent.action === "suggestion-comment")
              await this.verifyReviewComments(
                repository,
                workItem,
                positiveId(match.id),
                request.body.comments,
              );
          }
          if (intent.action === "create-pr") {
            const subject = await this.branchSubject(intent, repository, workItem);
            if (
              object(match.head).sha !== subject.headSha ||
              object(match.head).ref !== subject.branch
            )
              return delivery(
                "unknown",
                "The matching pull request has a different source branch or SHA.",
              );
          }
          return delivery(
            "succeeded",
            "Read-only reconciliation found the exact confirmed action.",
            String(positiveId(match.id)),
          );
        }
      }
      return delivery(
        "unknown",
        "Reconciliation reached its page budget without a complete result.",
      );
    } catch (error) {
      return delivery("unknown", this.failureMessage(error));
    }
  }

  private async preflightIdentity(
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationCommentTarget,
    actor: InvestigationOperatorPrincipal,
  ): Promise<{ repository: Json; value: Json }> {
    if (workItem.repositoryId !== repository.id || !actor.repositoryIds.includes(repository.id))
      throw new GitHubActionFailure("repository_scope_denied");
    const publisher = await this.readPublisherIdentity();
    if (
      actor.githubIdentity !== undefined &&
      (positiveId(actor.githubIdentity.githubUserId) !== publisher.githubUserId ||
        githubLogin(actor.githubIdentity.githubLogin).toLowerCase() !==
          publisher.githubLogin.toLowerCase())
    )
      throw new GitHubActionFailure("publisher_identity_changed");
    const base = repositoryPath(repository);
    const remoteRepository = object((await this.request(base)).value);
    if (
      positiveId(remoteRepository.id) !== repository.githubRepositoryId ||
      typeof remoteRepository.full_name !== "string" ||
      remoteRepository.full_name.toLowerCase() !== repository.fullName.toLowerCase()
    )
      throw new GitHubActionFailure("repository_identity_changed");
    const collection = workItem.kind === "pull_request" ? "pulls" : "issues";
    const value = object((await this.request(`${base}/${collection}/${workItem.number}`)).value);
    if (
      value.number !== workItem.number ||
      (workItem.kind === "issue" && value.pull_request !== undefined)
    )
      throw new GitHubActionFailure("work_item_identity_changed");
    const remoteWorkItemId = positiveId(value.id);
    if (
      workItem.githubWorkItemId !== undefined &&
      positiveId(workItem.githubWorkItemId) !== remoteWorkItemId
    )
      throw new GitHubActionFailure("work_item_identity_changed");
    return { repository: remoteRepository, value };
  }

  private targetFrom(
    value: Json,
    workItem: InvestigationWorkItemRecord,
  ): ActionContextV1["target"] {
    if (value.state !== "open" && value.state !== "closed")
      throw new GitHubActionFailure("invalid_target_state");
    if (workItem.kind === "pull_request") {
      const baseSha = sha(object(value.base).sha);
      const headSha = sha(object(value.head).sha);
      return {
        kind: "pull_request",
        state: value.merged === true ? "merged" : value.state,
        headSha,
        revisionKey: digest(`${baseSha}\0${headSha}`),
      };
    }
    if (
      typeof value.title !== "string" ||
      (value.body !== null && typeof value.body !== "string") ||
      typeof value.updated_at !== "string"
    )
      throw new GitHubActionFailure("invalid_issue_revision");
    return {
      kind: "issue",
      state: value.state,
      headSha: null,
      revisionKey: digest(JSON.stringify([value.title, value.body, value.state, value.updated_at])),
    };
  }

  private assertIntent(
    intent: InvestigationActionIntentV1,
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationWorkItemRecord,
    actor: InvestigationOperatorPrincipal,
  ): void {
    if (
      intent.repositoryId !== repository.id ||
      intent.workItemId !== workItem.id ||
      intent.actorId !== actor.id ||
      !this.supportedActions.includes(intent.action)
    )
      throw new GitHubActionFailure("invalid_action_scope");
    if (!actor.actionCapabilities.includes(intent.action))
      throw new GitHubActionFailure("action_permission_denied");
    if (!/^[A-Za-z0-9._:-]+$/u.test(intent.id) || !/^[a-f0-9]{64}$/u.test(intent.payloadDigest))
      throw new GitHubActionFailure("invalid_action_identity");
    if (contentDigest(intent.payload) !== intent.payloadDigest)
      throw new GitHubActionFailure("confirmed_payload_changed");
  }

  private assertRemotePermission(
    intent: Pick<InvestigationActionIntentV1, "action">,
    repository: Json,
    item: Json,
  ): void {
    const permissions = object(repository.permissions);
    const mayWrite =
      permissions.push === true || permissions.maintain === true || permissions.admin === true;
    const mayTriage = mayWrite || permissions.triage === true;
    const author = positiveId(object(item.user).id);
    if (
      ["approve", "request-changes"].includes(intent.action) &&
      author === this.options.expectedGitHubUserId
    )
      throw new GitHubActionFailure("cannot_review_own_pull_request");
    if (["merge", "trigger-ci"].includes(intent.action) && !mayWrite)
      throw new GitHubActionFailure("github_write_permission_required");
    if (
      ["close", "close-as-duplicate"].includes(intent.action) &&
      !mayTriage &&
      author !== this.options.expectedGitHubUserId
    )
      throw new GitHubActionFailure("github_close_permission_required");
    if (item.locked === true && !mayTriage)
      throw new GitHubActionFailure("github_conversation_locked");
  }

  private async prepareRequest(
    intent: InvestigationActionIntentV1,
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationWorkItemRecord,
  ): Promise<RemoteRequest> {
    const base = repositoryPath(repository);
    const payload = intent.payload;
    switch (intent.action) {
      case "comment":
        if (
          payload.kind !== "feedback" ||
          payload.drafts.some((draft) => draft.suggestion !== null)
        )
          throw new GitHubActionFailure("invalid_comment_payload");
        return {
          method: "POST",
          path: `${base}/issues/${workItem.number}/comments`,
          body: { body: messageBody(intent) },
        };
      case "approve":
      case "request-changes":
      case "suggestion-comment": {
        if (
          payload.kind !== "feedback" ||
          workItem.kind !== "pull_request" ||
          intent.expectedHeadSha === null
        )
          throw new GitHubActionFailure("pull_request_feedback_required");
        const comments = payload.drafts.flatMap((draft) => {
          const suggestion = draft.suggestion;
          if (suggestion === null) return [];
          if (suggestion.replacement.includes("```"))
            throw new GitHubActionFailure("unsafe_suggestion_fence");
          const body = `${draft.body}\n\n\`\`\`suggestion\n${suggestion.replacement}\n\`\`\``;
          if (Buffer.byteLength(body, "utf8") > 60_000)
            throw new GitHubActionFailure("suggestion_too_large");
          return [
            {
              path: suggestion.path,
              line: suggestion.endLine,
              side: "RIGHT",
              ...(suggestion.startLine === suggestion.endLine
                ? {}
                : { start_line: suggestion.startLine, start_side: "RIGHT" }),
              body,
            },
          ];
        });
        if (comments.length > 100)
          throw new GitHubActionFailure("feedback_requires_smaller_explicit_payload");
        return {
          method: "POST",
          path: `${base}/pulls/${workItem.number}/reviews`,
          body: {
            commit_id: intent.expectedHeadSha,
            body: messageBody(intent),
            event:
              intent.action === "approve"
                ? "APPROVE"
                : intent.action === "request-changes"
                  ? "REQUEST_CHANGES"
                  : "COMMENT",
            ...(comments.length ? { comments } : {}),
          },
        };
      }
      case "close":
      case "close-as-duplicate": {
        if (payload.kind !== "close") throw new GitHubActionFailure("invalid_close_payload");
        if (workItem.kind === "pull_request") {
          if (intent.action === "close-as-duplicate")
            throw new GitHubActionFailure("duplicate_requires_issue");
          return {
            method: "PATCH",
            path: `${base}/pulls/${workItem.number}`,
            body: { state: "closed" },
          };
        }
        let duplicateId: number | undefined;
        if (intent.action === "close-as-duplicate") {
          if (payload.duplicateNumber === null || payload.duplicateNumber === workItem.number)
            throw new GitHubActionFailure("invalid_duplicate_target");
          const original = object(
            (await this.request(`${base}/issues/${payload.duplicateNumber}`)).value,
          );
          if (original.number !== payload.duplicateNumber || original.pull_request !== undefined)
            throw new GitHubActionFailure("invalid_duplicate_target");
          duplicateId = positiveId(original.id);
        }
        return {
          method: "PATCH",
          path: `${base}/issues/${workItem.number}`,
          body: {
            state: "closed",
            state_reason:
              intent.action === "close-as-duplicate"
                ? "duplicate"
                : payload.reason === "duplicate"
                  ? "not_planned"
                  : payload.reason,
            ...(duplicateId === undefined ? {} : { duplicate_issue_id: duplicateId }),
          },
        };
      }
      case "merge":
        if (
          payload.kind !== "merge" ||
          workItem.kind !== "pull_request" ||
          intent.expectedHeadSha === null
        )
          throw new GitHubActionFailure("invalid_merge_payload");
        return {
          method: "PUT",
          path: `${base}/pulls/${workItem.number}/merge`,
          body: {
            sha: intent.expectedHeadSha,
            merge_method: payload.method,
            ...(payload.commitTitle ? { commit_title: payload.commitTitle } : {}),
          },
        };
      case "trigger-ci": {
        if (
          payload.kind !== "trigger-ci" ||
          !/^[A-Za-z0-9_.-]+$/u.test(payload.workflowId) ||
          Object.keys(payload.inputs).length > 25
        )
          throw new GitHubActionFailure("invalid_workflow_payload");
        const commit = object(
          (await this.request(`${base}/commits/${encodeURIComponent(payload.ref)}`)).value,
        );
        if (intent.expectedHeadSha === null || sha(commit.sha) !== intent.expectedHeadSha)
          throw new GitHubActionFailure("workflow_ref_changed");
        return {
          method: "POST",
          path: `${base}/actions/workflows/${encodeURIComponent(payload.workflowId)}/dispatches`,
          body: { ref: payload.ref, inputs: payload.inputs, return_run_details: true },
        };
      }
      case "create-pr": {
        if (payload.kind !== "create-pr")
          throw new GitHubActionFailure("invalid_create_pr_payload");
        const subject = await this.branchSubject(intent, repository, workItem);
        await this.checkBranch(repository, subject, payload.baseBranch);
        return {
          method: "POST",
          path: `${base}/pulls`,
          body: {
            head: subject.branch,
            base: payload.baseBranch,
            title: payload.title,
            body: `${payload.body}\n\n${marker(intent)}`,
            draft: payload.draft,
          },
        };
      }
      default:
        throw new GitHubActionFailure("unsupported_github_action");
    }
  }

  private async branchSubject(
    intent: InvestigationActionIntentV1,
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationWorkItemRecord,
  ): Promise<Extract<InvestigationSubjectV1, { kind: "remote_branch" }>> {
    if (intent.payload.kind !== "create-pr")
      throw new GitHubActionFailure("invalid_create_pr_payload");
    const subject = await this.options.resolveSubject?.(
      intent.payload.branchSubjectRef,
      repository.id,
      workItem.id,
    );
    if (
      !subject ||
      subject.kind !== "remote_branch" ||
      subject.id !== intent.payload.branchSubjectRef ||
      subject.repositoryId !== repository.id ||
      subject.workItemId !== workItem.id
    )
      throw new GitHubActionFailure("verified_remote_branch_required");
    return subject;
  }

  private async checkBranch(
    repository: InvestigationRepositoryRecord,
    subject: Extract<InvestigationSubjectV1, { kind: "remote_branch" }>,
    baseBranch?: string,
  ): Promise<void> {
    const base = repositoryPath(repository);
    const branch = object(
      (await this.request(`${base}/branches/${encodeURIComponent(subject.branch)}`)).value,
    );
    if (sha(object(branch.commit).sha) !== subject.headSha)
      throw new GitHubActionFailure("remote_branch_changed");
    if (baseBranch !== undefined) {
      if (
        !baseBranch ||
        baseBranch === subject.branch ||
        /\s/u.test(baseBranch) ||
        hasControlCharacters(baseBranch)
      )
        throw new GitHubActionFailure("invalid_base_branch");
      const target = object(
        (await this.request(`${base}/branches/${encodeURIComponent(baseBranch)}`)).value,
      );
      if (sha(object(target.commit).sha) !== subject.baseSha)
        throw new GitHubActionFailure("remote_base_changed");
    }
  }

  private async verifyReviewComments(
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationWorkItemRecord,
    reviewId: number,
    expected: unknown,
  ): Promise<void> {
    if (!Array.isArray(expected)) throw new GitHubActionFailure("missing_suggestion_preview");
    const actual: Json[] = [];
    for (let page = 1; page <= 2; page += 1) {
      const response = await this.request(
        `${repositoryPath(repository)}/pulls/${workItem.number}/reviews/${reviewId}/comments?per_page=100&page=${page}`,
      );
      if (!Array.isArray(response.value))
        throw new GitHubActionFailure("invalid_suggestion_receipt");
      actual.push(...response.value.map(object));
      if (response.value.length < 100) break;
    }
    if (actual.length !== expected.length)
      throw new GitHubActionFailure("suggestion_receipt_count_mismatch");
    for (const value of expected) {
      const wanted = object(value);
      if (
        !actual.some(
          (comment) =>
            comment.path === wanted.path &&
            comment.body === wanted.body &&
            (comment.line ?? comment.original_line) === wanted.line &&
            (comment.start_line ?? comment.original_start_line ?? null) ===
              (wanted.start_line ?? null),
        )
      )
        throw new GitHubActionFailure("suggestion_receipt_mismatch");
    }
  }

  private async request(
    path: string,
    method: "GET" | RemoteRequest["method"] = "GET",
    body?: Json,
  ): Promise<{ status: number; value: unknown }> {
    if (!path.startsWith("/") || path.startsWith("//") || /[\r\n\\]/u.test(path))
      throw new GitHubActionFailure("invalid_github_path");
    const response = await this.requestFetch(new URL(path, "https://api.github.com"), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "agentic-review-investigation/1",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const retryAfterMs = retryDelay(response.headers);
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (retryAfterMs !== undefined || response.headers.get("x-ratelimit-remaining") === "0"));
      await response.body?.cancel().catch(() => {});
      throw new GitHubActionFailure(
        rateLimited ? "github_rate_limited" : "github_request_rejected",
        response.status,
        retryAfterMs,
      );
    }
    if (response.status === 204) {
      await response.body?.cancel();
      return { status: response.status, value: null };
    }
    const reader = response.body?.getReader();
    if (!reader) throw new GitHubActionFailure("missing_github_response");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 8 * 1024 * 1024) throw new GitHubActionFailure("github_response_too_large");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return {
      status: response.status,
      value: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      ) as unknown,
    };
  }

  private failureMessage(error: unknown): string {
    return error instanceof GitHubActionFailure
      ? `GitHub action could not proceed: ${error.code}${error.status === null ? "" : ` (HTTP ${error.status})`}.`
      : "GitHub action could not be verified. Inspect the action diagnostics before continuing.";
  }
}
