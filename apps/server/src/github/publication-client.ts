import type {
  PublicationFailure,
  PublicationFailureCode,
  PublicationIntent,
  PublicationRemoteReceipt,
} from "@agentic-review/contracts";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { createPullRequestRevisionKey } from "./revision-key.js";

const origin = "https://api.github.com";
const maximumPageBytes = 8 * 1024 * 1024;
const maximumPages = 100;
const maximumRetryAfterMs = 24 * 60 * 60 * 1_000;
const reviewStates = {
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
  COMMENT: "COMMENTED",
} as const;
type JsonObject = Record<string, unknown>;

export type GitHubPublicationFailureOutcome = {
  status: "failed" | "blocked" | "unknown";
  failure: PublicationFailure;
  retryAfterMs?: number;
};
export type GitHubPublicationOutcome =
  | { status: "published"; remoteReceipt: PublicationRemoteReceipt }
  | GitHubPublicationFailureOutcome;
export type GitHubPublicationPreflightOutcome =
  | { status: "ready" }
  | GitHubPublicationFailureOutcome;

export interface GitHubPublicationTransport {
  preflight(
    intent: PublicationIntent,
    signal?: AbortSignal,
  ): Promise<GitHubPublicationPreflightOutcome>;
  publish(intent: PublicationIntent, signal?: AbortSignal): Promise<GitHubPublicationOutcome>;
  reconcile(intent: PublicationIntent, signal?: AbortSignal): Promise<GitHubPublicationOutcome>;
}

export interface GitHubPublicationClientOptions {
  readonly token: string;
  readonly expectedGitHubUserId: number;
  readonly userAgent?: string;
  readonly fetchImplementation?: typeof fetch;
  readonly requestTimeoutMs?: number;
  readonly reconciliationTimeoutMs?: number;
  readonly now?: () => number;
}

class InvalidResponse extends Error {}
class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly headers: Headers,
    readonly rateLimited = false,
  ) {
    super("GitHub rejected the request.");
  }
}

/** A dedicated publication credential is required. This client never retries a mutation. */
export class GitHubPublicationClient implements GitHubPublicationTransport {
  readonly #token: string;
  readonly #expectedGitHubUserId: number;
  readonly #userAgent: string;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;
  readonly #reconciliationTimeoutMs: number;
  readonly #now: () => number;

  constructor(options: GitHubPublicationClientOptions) {
    if (
      options.token.trim().length === 0 ||
      /[\r\n]/u.test(options.token) ||
      !positiveId(options.expectedGitHubUserId)
    ) {
      throw new TypeError(
        "A dedicated publication token and expected GitHub user ID are required.",
      );
    }
    this.#token = options.token;
    this.#expectedGitHubUserId = options.expectedGitHubUserId;
    this.#userAgent = options.userAgent ?? "agentic-review-publication/1.0";
    if (!/^[\x20-\x7e]{1,200}$/u.test(this.#userAgent))
      throw new TypeError("Invalid publication user agent.");
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
    this.#requestTimeoutMs = boundedTimeout(options.requestTimeoutMs ?? 15_000, 60_000);
    this.#reconciliationTimeoutMs = boundedTimeout(
      options.reconciliationTimeoutMs ?? 30_000,
      120_000,
    );
    this.#now = options.now ?? Date.now;
  }

  async preflight(
    intent: PublicationIntent,
    signal?: AbortSignal,
  ): Promise<GitHubPublicationPreflightOutcome> {
    const invalid = this.#checkIntent(intent);
    if (invalid) return invalid;
    try {
      const workItem = await this.#identity(intent, signal);
      if (workItem.state !== "open")
        return failure("blocked", "source_changed", "The GitHub work item is no longer open.");
      let revisionKey: string;
      if (intent.payload.kind === "pull_request_review") {
        const base = object(workItem.base);
        const head = object(workItem.head);
        const baseSha = string(base.sha).toLowerCase();
        const headSha = string(head.sha).toLowerCase();
        revisionKey = createPullRequestRevisionKey(baseSha, headSha);
        if (headSha !== intent.payload.commitId)
          return failure(
            "blocked",
            "source_changed",
            "The pull request head changed after approval.",
          );
      } else {
        if (
          typeof workItem.title !== "string" ||
          !(typeof workItem.body === "string" || workItem.body === null)
        )
          throw new InvalidResponse();
        const updatedAt = timestamp(workItem.updated_at);
        // Preserve the source timestamp spelling used by webhook and polling normalization.
        revisionKey = sha256(
          JSON.stringify([workItem.title, workItem.body, workItem.state, updatedAt]),
        );
      }
      return revisionKey === intent.binding.revisionKey
        ? { status: "ready" }
        : failure(
            "blocked",
            "source_changed",
            "The GitHub source revision changed after approval.",
          );
    } catch (error) {
      return this.#readFailure(error, false);
    }
  }

  async publish(
    intent: PublicationIntent,
    signal?: AbortSignal,
  ): Promise<GitHubPublicationOutcome> {
    const invalid = this.#checkIntent(intent);
    if (invalid) return invalid;
    const payload = intent.payload;
    const body =
      payload.kind === "pull_request_review"
        ? { commit_id: payload.commitId, body: payload.body, event: payload.event }
        : { body: payload.body };
    try {
      const response = await this.#request(endpoint(intent), "POST", signal, JSON.stringify(body));
      if (response.status !== (payload.kind === "pull_request_review" ? 200 : 201))
        throw new InvalidResponse();
      const receipt = receiptFor(response.value, intent);
      if (!receipt) throw new InvalidResponse();
      return { status: "published", remoteReceipt: receipt };
    } catch (error) {
      if (
        error instanceof HttpFailure &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      ) {
        return this.#definiteRejection(error);
      }
      // Even an unreadable success or an aborted request may have created the remote object.
      return failure(
        "unknown",
        "ambiguous_delivery",
        "GitHub delivery could not be confirmed. Reconcile before any further action.",
      );
    }
  }

  async reconcile(
    intent: PublicationIntent,
    signal?: AbortSignal,
  ): Promise<GitHubPublicationOutcome> {
    const invalid = this.#checkIntent(intent);
    if (invalid)
      return failure(
        "unknown",
        "reconciliation_mismatch",
        "The frozen publication identity or payload cannot be verified.",
      );
    const deadline = deadlineSignal(signal, this.#reconciliationTimeoutMs);
    try {
      // A historical delivery can be reconciled after source updates or closure.
      await this.#identity(intent, deadline.signal);
      const path = endpoint(intent);
      let page = 1;
      const visited = new Set<number>();
      const ids = new Set<number>();
      const matches: PublicationRemoteReceipt[] = [];
      let mismatched = false;
      for (;;) {
        if (visited.size >= maximumPages || visited.has(page)) throw new InvalidResponse();
        visited.add(page);
        const response = await this.#request(
          `${path}?per_page=100&page=${page}`,
          "GET",
          deadline.signal,
        );
        if (
          response.status !== 200 ||
          !Array.isArray(response.value) ||
          response.value.length > 100
        )
          throw new InvalidResponse();
        for (const value of response.value) {
          const item = object(value);
          if (!positiveId(item.id) || typeof item.body !== "string") throw new InvalidResponse();
          if (ids.has(item.id)) throw new InvalidResponse();
          ids.add(item.id);
          if (!item.body.includes(`${markerPrefix(intent)} `)) continue;
          const receipt = receiptFor(item, intent);
          if (receipt) matches.push(receipt);
          else mismatched = true;
        }
        const next = nextPage(response.headers.get("link"), path, page);
        if (next === null) break;
        page = next;
      }
      if (matches.length > 1)
        return failure(
          "unknown",
          "reconciliation_multiple_matches",
          "Multiple GitHub objects match the frozen publication.",
        );
      if (mismatched)
        return failure(
          "unknown",
          "reconciliation_mismatch",
          "A GitHub publication marker has different content, identity, or review state.",
        );
      const receipt = matches[0];
      if (receipt) return { status: "published", remoteReceipt: receipt };
      return failure(
        "unknown",
        "reconciliation_no_match",
        "No complete GitHub publication match was found. Absence does not authorize resending.",
      );
    } catch (error) {
      return this.#readFailure(error, true);
    } finally {
      deadline.dispose();
    }
  }

  #checkIntent(intent: PublicationIntent): GitHubPublicationFailureOutcome | null {
    if (intent.publisherGitHubUserId !== this.#expectedGitHubUserId)
      return failure(
        "blocked",
        "publisher_identity_mismatch",
        "The configured publisher differs from the approved publisher.",
      );
    const target = intent.target;
    const payload = intent.payload;
    const names = target.fullName.split("/");
    if (
      names.length !== 2 ||
      names.some((name) => !/^[A-Za-z0-9_.-]+$/u.test(name) || name === "." || name === "..") ||
      !positiveId(target.githubRepositoryId) ||
      !positiveId(target.githubWorkItemId) ||
      !positiveId(target.number) ||
      !["pull_request", "issue"].includes(target.kind) ||
      !["pull_request_review", "issue_comment"].includes(payload.kind) ||
      (target.kind === "pull_request") !== (payload.kind === "pull_request_review")
    ) {
      return failure(
        "blocked",
        "target_identity_mismatch",
        "The approved GitHub target is invalid.",
      );
    }
    const marker = `${markerPrefix(intent)} semantic-sha256:${intent.semanticSha256} -->`;
    const markerStart = payload.body.indexOf(marker);
    if (
      !/^[a-f0-9]{64}$/u.test(intent.semanticSha256) ||
      markerStart < 1 ||
      !payload.body.endsWith(marker) ||
      payload.body.indexOf(markerPrefix(intent)) !==
        payload.body.lastIndexOf(markerPrefix(intent)) ||
      payload.body[markerStart - 1] !== "\n" ||
      sha256(payload.body.slice(0, markerStart - 1)) !== intent.semanticSha256 ||
      sha256(canonicalJson(payload)) !== intent.payloadSha256 ||
      Buffer.byteLength(payload.body, "utf8") > 60_000 ||
      !payload.body.isWellFormed()
    ) {
      return failure(
        "blocked",
        "preflight_failed",
        "The frozen publication body or digest is invalid.",
      );
    }
    if (
      payload.kind === "pull_request_review" &&
      (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(payload.commitId) ||
        !Object.hasOwn(reviewStates, payload.event))
    )
      return failure(
        "blocked",
        "preflight_failed",
        "The frozen review commit or event is invalid.",
      );
    return null;
  }

  async #identity(intent: PublicationIntent, signal?: AbortSignal): Promise<JsonObject> {
    const identity = await this.#readObject("/user", signal);
    if (identity.id !== this.#expectedGitHubUserId || identity.id !== intent.publisherGitHubUserId)
      throw new IdentityFailure("publisher_identity_mismatch");
    const repositoryPath = `/repos/${intent.target.fullName}`;
    const repository = await this.#readObject(repositoryPath, signal);
    if (
      repository.id !== intent.target.githubRepositoryId ||
      repository.full_name !== intent.target.fullName
    )
      throw new IdentityFailure("target_identity_mismatch");
    const segment = intent.target.kind === "pull_request" ? "pulls" : "issues";
    const workItem = await this.#readObject(
      `${repositoryPath}/${segment}/${intent.target.number}`,
      signal,
    );
    const htmlSegment = intent.target.kind === "pull_request" ? "pull" : "issues";
    if (
      workItem.id !== intent.target.githubWorkItemId ||
      workItem.number !== intent.target.number ||
      workItem.html_url !==
        `https://github.com/${intent.target.fullName}/${htmlSegment}/${intent.target.number}` ||
      (intent.target.kind === "issue"
        ? "pull_request" in workItem
        : !(isObject(workItem.head) && isObject(workItem.base)))
    )
      throw new IdentityFailure("target_identity_mismatch");
    return workItem;
  }

  async #readObject(path: string, signal?: AbortSignal): Promise<JsonObject> {
    const response = await this.#request(path, "GET", signal);
    if (response.status !== 200) throw new InvalidResponse();
    return object(response.value);
  }

  async #request(
    path: string,
    method: "GET" | "POST",
    signal?: AbortSignal,
    body?: string,
  ): Promise<{ status: number; value: unknown; headers: Headers }> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new InvalidResponse();
    const deadline = deadlineSignal(signal, this.#requestTimeoutMs);
    try {
      const headers = new Headers({
        authorization: `Bearer ${this.#token}`,
        accept: "application/vnd.github+json",
        "user-agent": this.#userAgent,
        "x-github-api-version": "2022-11-28",
      });
      if (body !== undefined) headers.set("content-type", "application/json");
      if (deadline.signal.aborted) throw new InvalidResponse();
      const response = await abortable(
        this.#fetch(`${origin}${path}`, {
          method,
          headers,
          redirect: "error",
          cache: "no-store",
          signal: deadline.signal,
          ...(body === undefined ? {} : { body }),
        }),
        deadline.signal,
      );
      if (response.status < 200 || response.status >= 300) {
        let rateLimited = false;
        if (response.status === 403) {
          try {
            const error = object(await readJson(response, deadline.signal));
            rateLimited =
              typeof error.message === "string" &&
              /(?:secondary rate limit|rate limit exceeded)/iu.test(error.message);
          } catch {
            /* The received rejection remains definite even when its body is unreadable. */
          }
        }
        void response.body?.cancel().catch(() => {});
        throw new HttpFailure(response.status, response.headers, rateLimited);
      }
      const value = await readJson(response, deadline.signal);
      return { status: response.status, headers: response.headers, value };
    } finally {
      deadline.dispose();
    }
  }

  #readFailure(error: unknown, reconciliation: boolean): GitHubPublicationFailureOutcome {
    if (reconciliation)
      return failure(
        "unknown",
        "reconciliation_incomplete",
        "GitHub reconciliation was incomplete. The publication remains unknown.",
      );
    if (error instanceof IdentityFailure)
      return failure(
        "blocked",
        error.code,
        "The current GitHub identity does not match the approved publication.",
      );
    if (error instanceof HttpFailure && error.status >= 400 && error.status < 500)
      return this.#definiteRejection(error);
    return failure(
      "failed",
      "preflight_failed",
      "GitHub preflight could not verify the approved source.",
    );
  }

  #definiteRejection(error: HttpFailure): GitHubPublicationFailureOutcome {
    if (
      (error.status === 403 || error.status === 429) &&
      (error.status === 429 ||
        error.rateLimited ||
        error.headers.has("retry-after") ||
        error.headers.get("x-ratelimit-remaining") === "0")
    ) {
      const retryAfterMs = rateLimitDelay(error.headers, this.#now());
      return {
        ...failure(
          retryAfterMs === null ? "blocked" : "failed",
          "rate_limited",
          "GitHub rejected the request due to rate limiting.",
        ),
        ...(retryAfterMs === null ? {} : { retryAfterMs }),
      };
    }
    return failure(
      error.status === 401 || error.status === 403 ? "blocked" : "failed",
      "github_rejected",
      `GitHub rejected the request with HTTP ${error.status}.`,
    );
  }
}

class IdentityFailure extends Error {
  constructor(readonly code: "publisher_identity_mismatch" | "target_identity_mismatch") {
    super("GitHub identity mismatch.");
  }
}
function failure(
  status: GitHubPublicationFailureOutcome["status"],
  code: PublicationFailureCode,
  message: string,
): GitHubPublicationFailureOutcome {
  return { status, failure: { code, message } };
}
function endpoint(intent: PublicationIntent): string {
  return `/repos/${intent.target.fullName}/${intent.payload.kind === "pull_request_review" ? "pulls" : "issues"}/${intent.target.number}/${intent.payload.kind === "pull_request_review" ? "reviews" : "comments"}`;
}
function markerPrefix(intent: PublicationIntent): string {
  return `<!-- agentic-review-publication:${intent.publicationId}`;
}
function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown): JsonObject {
  if (!isObject(value)) throw new InvalidResponse();
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new InvalidResponse();
  return value;
}
function timestamp(value: unknown): string {
  const text = string(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(text) ||
    !Number.isFinite(Date.parse(text)) ||
    new Date(text).toISOString().slice(0, 19) !== text.slice(0, 19)
  )
    throw new InvalidResponse();
  return text;
}
function boundedTimeout(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new TypeError("Publication timeout is outside the supported range.");
  return value;
}

function receiptFor(value: unknown, intent: PublicationIntent): PublicationRemoteReceipt | null {
  try {
    const item = object(value);
    if (
      !positiveId(item.id) ||
      object(item.user).id !== intent.publisherGitHubUserId ||
      item.body !== intent.payload.body
    )
      return null;
    const prefix = `https://github.com/${intent.target.fullName}`;
    if (intent.payload.kind === "pull_request_review") {
      if (
        item.commit_id !== intent.payload.commitId ||
        item.state !== reviewStates[intent.payload.event] ||
        item.html_url !== `${prefix}/pull/${intent.target.number}#pullrequestreview-${item.id}`
      )
        return null;
      return {
        kind: "pull_request_review",
        githubId: item.id,
        htmlUrl: item.html_url,
        createdAt: new Date(timestamp(item.submitted_at)).toISOString(),
        publisherGitHubUserId: intent.publisherGitHubUserId,
        commitId: intent.payload.commitId,
        event: intent.payload.event,
      };
    }
    if (
      item.html_url !== `${prefix}/issues/${intent.target.number}#issuecomment-${item.id}` ||
      item.issue_url !== `${origin}/repos/${intent.target.fullName}/issues/${intent.target.number}`
    )
      return null;
    return {
      kind: "issue_comment",
      githubId: item.id,
      htmlUrl: item.html_url,
      createdAt: new Date(timestamp(item.created_at)).toISOString(),
      publisherGitHubUserId: intent.publisherGitHubUserId,
    };
  } catch {
    return null;
  }
}

function nextPage(link: string | null, path: string, page: number): number | null {
  if (link === null) return null;
  let next: number | null = null;
  for (const section of link.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="(next|prev|first|last)"\s*$/u.exec(section);
    if (!match?.[1] || !match[2]) throw new InvalidResponse();
    const url = new URL(match[1]);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== path ||
      [...url.searchParams.keys()].some((key) => key !== "page" && key !== "per_page") ||
      url.searchParams.getAll("page").length !== 1 ||
      url.searchParams.getAll("per_page").length !== 1 ||
      url.searchParams.get("per_page") !== "100"
    )
      throw new InvalidResponse();
    const value = url.searchParams.get("page") ?? "";
    if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value)))
      throw new InvalidResponse();
    if (match[2] === "next") {
      if (next !== null || Number(value) !== page + 1 || Number(value) > maximumPages)
        throw new InvalidResponse();
      next = Number(value);
    }
  }
  return next;
}

function rateLimitDelay(headers: Headers, now: number): number | null {
  const waits: number[] = [];
  const retry = headers.get("retry-after");
  if (retry !== null) {
    if (!/^\d+(?:\.\d+)?$/u.test(retry)) return null;
    waits.push(Math.ceil(Number(retry) * 1_000));
  }
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = headers.get("x-ratelimit-reset") ?? "";
    if (!/^\d+$/u.test(reset)) return null;
    waits.push(Math.max(0, Number(reset) * 1_000 - now));
  }
  const delay = waits.length === 0 ? 60_000 : Math.max(...waits);
  return Number.isSafeInteger(delay) && delay <= maximumRetryAfterMs ? delay : null;
}

function deadlineSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new InvalidResponse());
    if (signal.aborted) {
      operation.catch(() => {});
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximumPageBytes)) {
    void response.body?.cancel().catch(() => {});
    throw new InvalidResponse();
  }
  if (response.body === null) throw new InvalidResponse();
  const reader = response.body.getReader();
  let count = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      count += result.value.byteLength;
      if (count > maximumPageBytes) throw new InvalidResponse();
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    void reader.cancel().catch(() => {});
  }
}
