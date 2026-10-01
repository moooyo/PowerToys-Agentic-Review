import type { InvestigationWorkItemAuthor } from "@agentic-review/contracts";
import { requireCondition } from "./errors.js";
import { readGitHubUserIdentity } from "./github-identity.js";
import type { InvestigationStore } from "./store.js";
import type {
  InvestigationOperatorPrincipal,
  InvestigationRepositoryRecord,
  InvestigationWorkItemRecord,
} from "./types.js";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Reads only author metadata. It never refreshes historical work item or snapshot records. */
export class InvestigationWorkItemAuthorReader {
  readonly #cache = new Map<string, { result: InvestigationWorkItemAuthor; expiresAt: number }>();
  readonly #pending = new Map<string, Promise<InvestigationWorkItemAuthor>>();

  constructor(
    private readonly options: {
      readonly store: InvestigationStore;
      readonly token?: string;
      readonly fetch?: typeof globalThis.fetch;
      readonly now?: () => number;
      readonly requestTimeoutMs?: number;
    },
  ) {}

  async read(
    actor: InvestigationOperatorPrincipal,
    workItemId: string,
  ): Promise<InvestigationWorkItemAuthor> {
    const item = this.options.store.get<InvestigationWorkItemRecord>("workItems", workItemId);
    requireCondition(
      item !== undefined,
      404,
      "work_item_not_found",
      "The requested work item does not exist.",
    );
    requireCondition(
      item.id === workItemId,
      409,
      "work_item_identity_mismatch",
      "The saved work item identity does not match its record.",
    );
    requireCondition(
      actor.repositoryIds.includes(item.repositoryId),
      403,
      "repository_forbidden",
      "This identity has no access to the repository.",
    );
    const repository = this.options.store.get<InvestigationRepositoryRecord>(
      "repositories",
      item.repositoryId,
    );
    requireCondition(
      repository !== undefined,
      404,
      "repository_not_found",
      "The work item's repository is unavailable.",
    );
    requireCondition(
      repository.id === item.repositoryId,
      409,
      "repository_identity_mismatch",
      "The saved repository identity does not match the work item.",
    );
    const stored = object(item.author);
    if (stored !== null) {
      const author = readGitHubUserIdentity({
        id: stored.githubUserId,
        login: stored.login,
        avatar_url: stored.avatarUrl,
        html_url: stored.htmlUrl,
      });
      if (author !== null)
        return { workItemId: item.id, repositoryId: item.repositoryId, author, source: "stored" };
    }
    const key = JSON.stringify([
      item.id,
      item.repositoryId,
      item.kind,
      item.number,
      item.githubWorkItemId,
      repository.fullName,
      repository.githubRepositoryId,
    ]);
    const now = this.options.now ?? Date.now;
    const cached = this.#cache.get(key);
    if (cached !== undefined && cached.expiresAt > now()) return structuredClone(cached.result);
    const pending = this.#pending.get(key);
    if (pending !== undefined) return structuredClone(await pending);
    const request = this.#readUpstream(repository, item);
    this.#pending.set(key, request);
    try {
      const result = await request;
      this.#cache.set(key, {
        result,
        expiresAt: now() + (result.source === "github" ? 5 * 60_000 : 30_000),
      });
      while (this.#cache.size > 1_024) this.#cache.delete(this.#cache.keys().next().value!);
      return structuredClone(result);
    } finally {
      this.#pending.delete(key);
    }
  }

  async #readUpstream(
    repository: InvestigationRepositoryRecord,
    item: InvestigationWorkItemRecord,
  ): Promise<InvestigationWorkItemAuthor> {
    const unavailable = (reason: string): InvestigationWorkItemAuthor => ({
      workItemId: item.id,
      repositoryId: item.repositoryId,
      author: null,
      source: "unavailable",
      reason,
    });
    const parts = repository.fullName.split("/");
    if (
      parts.length !== 2 ||
      parts.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part) || part === "." || part === "..") ||
      !Number.isSafeInteger(repository.githubRepositoryId) ||
      repository.githubRepositoryId < 1 ||
      !Number.isSafeInteger(item.number) ||
      item.number < 1 ||
      (item.kind !== "pull_request" && item.kind !== "issue")
    )
      return unavailable("saved_author_scope_invalid");
    const base = `/repos/${parts.map(encodeURIComponent).join("/")}`;
    const observedRepository = await this.#get(base);
    if (observedRepository === null) return unavailable("github_repository_unavailable");
    if (
      observedRepository.id !== repository.githubRepositoryId ||
      typeof observedRepository.full_name !== "string" ||
      observedRepository.full_name.toLowerCase() !== repository.fullName.toLowerCase()
    )
      return unavailable("github_repository_mismatch");
    const upstream = await this.#get(
      `${base}/${item.kind === "pull_request" ? "pulls" : "issues"}/${item.number}`,
    );
    if (upstream === null) return unavailable("github_work_item_unavailable");
    if (
      upstream.number !== item.number ||
      typeof upstream.id !== "number" ||
      !Number.isSafeInteger(upstream.id) ||
      upstream.id < 1 ||
      (item.githubWorkItemId !== undefined && upstream.id !== item.githubWorkItemId) ||
      (item.kind === "issue" && upstream.pull_request !== undefined) ||
      (item.kind === "pull_request" &&
        object(object(upstream.base)?.repo)?.id !== repository.githubRepositoryId)
    )
      return unavailable("github_work_item_mismatch");
    const author = readGitHubUserIdentity(upstream.user);
    return author === null
      ? unavailable("github_author_unavailable")
      : { workItemId: item.id, repositoryId: item.repositoryId, author, source: "github" };
  }

  async #get(path: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(
        `https://api.github.com${path}`,
        {
          method: "GET",
          redirect: "error",
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "agentic-review-author-metadata",
            ...(this.options.token === undefined
              ? {}
              : { authorization: `Bearer ${this.options.token}` }),
          },
          signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 10_000),
        },
      );
      return response.ok ? object(await response.json()) : null;
    } catch {
      return null;
    }
  }
}
