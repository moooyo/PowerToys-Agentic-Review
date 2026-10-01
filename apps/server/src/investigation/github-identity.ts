import type { InvestigationGitHubUser } from "@agentic-review/contracts";
import { InvestigationRequestError, requireCondition } from "./errors.js";

const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\[bot\])?$/u;

export function githubIdentityUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Optional source metadata must not prevent importing older or minimal snapshots. */
export function readGitHubUserIdentity(value: unknown): InvestigationGitHubUser | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const user = value as Record<string, unknown>;
  if (
    typeof user.id !== "number" ||
    !Number.isSafeInteger(user.id) ||
    user.id < 1 ||
    typeof user.login !== "string" ||
    !loginPattern.test(user.login)
  )
    return null;
  return {
    githubUserId: user.id,
    login: user.login,
    avatarUrl: githubIdentityUrl(user.avatar_url),
    htmlUrl: githubIdentityUrl(user.html_url),
  };
}

/** Performs only GitHub profile GET requests and caches successful observations. */
export class InvestigationGitHubIdentityResolver {
  readonly #cache = new Map<string, { identity: InvestigationGitHubUser; expiresAt: number }>();
  readonly #pending = new Map<string, Promise<InvestigationGitHubUser>>();

  constructor(
    private readonly options: {
      readonly token?: string;
      readonly fetch?: typeof globalThis.fetch;
      readonly now?: () => number;
      readonly requestTimeoutMs?: number;
    } = {},
  ) {}

  async resolve(lookup: string): Promise<InvestigationGitHubUser> {
    const normalized = lookup.startsWith("@") ? lookup.slice(1) : lookup;
    const numeric = !lookup.startsWith("@") && /^[0-9]+$/u.test(normalized);
    requireCondition(
      numeric
        ? /^[1-9][0-9]*$/u.test(normalized) && Number.isSafeInteger(Number(normalized))
        : loginPattern.test(normalized),
      400,
      "invalid_github_user_lookup",
      "Enter a GitHub username or positive safe numeric user ID.",
    );
    const key = numeric ? `id:${normalized}` : `login:${normalized.toLowerCase()}`;
    const now = this.options.now ?? Date.now;
    const cached = this.#cache.get(key);
    if (cached !== undefined && cached.expiresAt > now()) return { ...cached.identity };
    const pending = this.#pending.get(key);
    if (pending !== undefined) return { ...(await pending) };
    const request = this.#read(normalized, numeric);
    this.#pending.set(key, request);
    try {
      const identity = await request;
      const entry = { identity, expiresAt: now() + 15 * 60_000 };
      this.#cache.set(`id:${identity.githubUserId}`, entry);
      this.#cache.set(`login:${identity.login.toLowerCase()}`, entry);
      while (this.#cache.size > 2_048) this.#cache.delete(this.#cache.keys().next().value!);
      return { ...identity };
    } finally {
      this.#pending.delete(key);
    }
  }

  async #read(lookup: string, numeric: boolean): Promise<InvestigationGitHubUser> {
    const path = numeric ? `user/${lookup}` : `users/${encodeURIComponent(lookup)}`;
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(`https://api.github.com/${path}`, {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "agentic-review-intake",
          ...(this.options.token === undefined
            ? {}
            : { authorization: `Bearer ${this.options.token}` }),
        },
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 10_000),
      });
    } catch {
      throw new InvestigationRequestError(
        502,
        "github_user_lookup_failed",
        "GitHub profile lookup could not be completed.",
      );
    }
    if (response.status === 404)
      throw new InvestigationRequestError(
        404,
        "github_user_not_found",
        "GitHub user was not found.",
      );
    if (!response.ok)
      throw new InvestigationRequestError(
        502,
        "github_user_lookup_failed",
        "GitHub profile lookup returned an unsuccessful response.",
      );
    let identity: InvestigationGitHubUser | null;
    try {
      identity = readGitHubUserIdentity(await response.json());
    } catch {
      identity = null;
    }
    requireCondition(
      identity !== null && (!numeric || identity.githubUserId === Number(lookup)),
      502,
      "invalid_github_user_response",
      "GitHub profile lookup returned an invalid user identity.",
    );
    return identity;
  }
}
