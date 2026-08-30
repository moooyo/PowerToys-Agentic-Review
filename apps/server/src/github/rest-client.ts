import type {
  GitHubIdentitySnapshot,
  GitHubIssueSnapshot,
  GitHubPage,
  GitHubPullRequestSnapshot,
  GitHubRateLimitState,
  GitHubReadClient,
  GitHubReadRequestBase,
  GitHubRepositorySnapshot,
  GitHubSearchItem,
  GitHubSearchRequest,
  GitHubTimelineEvent,
  GitHubTimelineReadRequest,
  GitHubWorkItemReadRequest,
} from "./poller.js";

const DEFAULT_API_VERSION = "2022-11-28";
const DEFAULT_BASE_URL = "https://api.github.com/";
const DEFAULT_MAX_CACHED_RESPONSES = 512;
const MAX_ERROR_BODY_LENGTH = 4_096;

type FetchImplementation = typeof globalThis.fetch;
type JsonObject = Record<string, unknown>;

export interface GitHubRestResponseObservation {
  readonly method: "GET";
  readonly requestUrl: string;
  readonly status: number;
  readonly notModified: boolean;
  readonly rateLimit?: GitHubRateLimitState;
}

export type ObserveGitHubRestResponse = (
  observation: GitHubRestResponseObservation,
) => void | Promise<void>;

export interface GitHubRestClientOptions {
  readonly token: string;
  readonly userAgent: string;
  readonly apiVersion?: string;
  readonly baseUrl?: string;
  readonly maxCachedResponses?: number;
  readonly requestTimeoutMs?: number;
  readonly fetchImplementation?: FetchImplementation;
  readonly observeResponse?: ObserveGitHubRestResponse;
}

export class GitHubRestApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly requestUrl: string,
    public readonly responseBody: string | null,
  ) {
    super(message);
    this.name = "GitHubRestApiError";
  }
}

export class InvalidGitHubRestResponseError extends Error {
  public constructor(
    message: string,
    public readonly requestUrl: string,
  ) {
    super(message);
    this.name = "InvalidGitHubRestResponseError";
  }
}

interface CachedResponse {
  readonly etag: string;
  readonly data: unknown;
  readonly nextPage: number | null;
}

interface JsonResponse<T> {
  readonly data: T;
  readonly nextPage: number | null;
  readonly rateLimit?: GitHubRateLimitState;
}

export class GitHubRestClient implements GitHubReadClient {
  readonly #token: string;
  readonly #userAgent: string;
  readonly #apiVersion: string;
  readonly #baseUrl: URL;
  readonly #maxCachedResponses: number;
  readonly #fetch: FetchImplementation;
  readonly #requestTimeoutMs: number | undefined;
  readonly #observeResponse: ObserveGitHubRestResponse | undefined;
  readonly #cache = new Map<string, CachedResponse>();

  public constructor(options: GitHubRestClientOptions) {
    validateHeaderValue(options.token, "token");
    validateHeaderValue(options.userAgent, "userAgent");
    this.#token = options.token;
    this.#userAgent = options.userAgent;
    this.#apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(this.#apiVersion)) {
      throw new TypeError("apiVersion must use the YYYY-MM-DD format.");
    }
    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#maxCachedResponses = options.maxCachedResponses ?? DEFAULT_MAX_CACHED_RESPONSES;
    if (!Number.isSafeInteger(this.#maxCachedResponses) || this.#maxCachedResponses <= 0) {
      throw new RangeError("maxCachedResponses must be a positive safe integer.");
    }
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    if (
      this.#requestTimeoutMs !== undefined &&
      (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs <= 0)
    ) {
      throw new RangeError("requestTimeoutMs must be a positive safe integer when configured.");
    }
    this.#observeResponse = options.observeResponse;
  }

  public async getRepository(request: GitHubReadRequestBase): Promise<GitHubRepositorySnapshot> {
    const repositoryPath = repositoryApiPath(request.repositoryFullName);
    const response = await this.#getJson<JsonObject>(repositoryPath, undefined, request.signal);
    return mapRepository(response.data, responseUrl(this.#baseUrl, repositoryPath));
  }

  public async searchIssuesAndPullRequests(
    request: GitHubSearchRequest,
  ): Promise<GitHubPage<GitHubSearchItem>> {
    const query = new URLSearchParams({
      q: request.query,
      page: String(positiveInteger(request.page, "page")),
      per_page: String(pageSize(request.perPage)),
    });
    const response = await this.#getJson<JsonObject>("search/issues", query, request.signal);
    const requestUrl = responseUrl(this.#baseUrl, "search/issues", query);
    const payload = expectObject(response.data, "response", requestUrl);
    const items = expectArray(payload.items, "response.items", requestUrl).map((value, index) =>
      mapSearchItem(value, `response.items[${index}]`, requestUrl),
    );
    const totalCount = readNonNegativeInteger(
      payload.total_count,
      "response.total_count",
      requestUrl,
    );
    const incompleteResults = readBoolean(
      payload.incomplete_results,
      "response.incomplete_results",
      requestUrl,
    );
    const visibleResultLimit = Math.min(totalCount, 1_000);
    const observedThrough = (request.page - 1) * request.perPage + items.length;
    const paginationEndedEarly = response.nextPage === null && observedThrough < visibleResultLimit;
    return {
      ...page(items, response),
      incomplete: incompleteResults || totalCount > 1_000 || paginationEndedEarly,
    };
  }

  public async getIssue(request: GitHubWorkItemReadRequest): Promise<GitHubIssueSnapshot> {
    const path = `${repositoryApiPath(request.repositoryFullName)}/issues/${positiveInteger(
      request.number,
      "number",
    )}`;
    const response = await this.#getJson<JsonObject>(path, undefined, request.signal);
    return mapIssue(response.data, responseUrl(this.#baseUrl, path));
  }

  public async getPullRequest(
    request: GitHubWorkItemReadRequest,
  ): Promise<GitHubPullRequestSnapshot> {
    const path = `${repositoryApiPath(request.repositoryFullName)}/pulls/${positiveInteger(
      request.number,
      "number",
    )}`;
    const response = await this.#getJson<JsonObject>(path, undefined, request.signal);
    return mapPullRequest(response.data, responseUrl(this.#baseUrl, path));
  }

  public async listIssueTimelineEvents(
    request: GitHubTimelineReadRequest,
  ): Promise<GitHubPage<GitHubTimelineEvent>> {
    const path = `${repositoryApiPath(request.repositoryFullName)}/issues/${positiveInteger(
      request.number,
      "number",
    )}/timeline`;
    const query = new URLSearchParams({
      page: String(positiveInteger(request.page, "page")),
      per_page: String(pageSize(request.perPage)),
    });
    const response = await this.#getJson<unknown[]>(path, query, request.signal);
    const requestUrl = responseUrl(this.#baseUrl, path, query);
    const items: GitHubTimelineEvent[] = [];
    for (const [index, value] of expectArray(response.data, "response", requestUrl).entries()) {
      const event = mapTimelineEvent(value, `response[${index}]`, requestUrl);
      if (event !== null) {
        items.push(event);
      }
    }
    return page(items, response);
  }

  async #getJson<T>(
    path: string,
    query: URLSearchParams | undefined,
    signal: AbortSignal | undefined,
  ): Promise<JsonResponse<T>> {
    signal?.throwIfAborted();
    const url = new URL(path, this.#baseUrl);
    if (query !== undefined) {
      url.search = query.toString();
    }
    const cacheKey = url.href;
    const cached = this.#cache.get(cacheKey);
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.#token}`,
      "User-Agent": this.#userAgent,
      "X-GitHub-Api-Version": this.#apiVersion,
    });
    if (cached !== undefined) {
      headers.set("If-None-Match", cached.etag);
    }

    const timeoutSignal =
      this.#requestTimeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(this.#requestTimeoutMs);
    const requestSignal =
      signal === undefined
        ? timeoutSignal
        : timeoutSignal === undefined
          ? signal
          : AbortSignal.any([signal, timeoutSignal]);
    const response = await this.#fetch(url, {
      method: "GET",
      headers,
      ...(requestSignal === undefined ? {} : { signal: requestSignal }),
    });
    const rateLimit = readRateLimit(response.headers);
    await this.#observe({
      method: "GET",
      requestUrl: url.href,
      status: response.status,
      notModified: response.status === 304,
      ...(rateLimit === undefined ? {} : { rateLimit }),
    });
    signal?.throwIfAborted();

    if (response.status === 304) {
      if (cached === undefined) {
        throw new InvalidGitHubRestResponseError(
          "GitHub returned 304 without a matching cached representation.",
          url.href,
        );
      }
      this.#touchCache(cacheKey, cached);
      return {
        data: cached.data as T,
        nextPage: cached.nextPage,
        ...(rateLimit === undefined ? {} : { rateLimit }),
      };
    }

    if (!response.ok) {
      const responseBody = redactSecret(await readErrorBody(response), this.#token);
      throw new GitHubRestApiError(
        `GitHub REST GET ${url.pathname} failed with status ${response.status}.`,
        response.status,
        url.href,
        responseBody,
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      throw new InvalidGitHubRestResponseError(
        `GitHub REST GET ${url.pathname} returned invalid JSON: ${errorMessage(error)}.`,
        url.href,
      );
    }
    const nextPage = readNextPage(response.headers.get("link"), url.href);
    const etag = response.headers.get("etag");
    if (etag !== null && etag.length > 0) {
      this.#touchCache(cacheKey, { etag, data, nextPage });
    }
    return {
      data: data as T,
      nextPage,
      ...(rateLimit === undefined ? {} : { rateLimit }),
    };
  }

  async #observe(observation: GitHubRestResponseObservation): Promise<void> {
    if (this.#observeResponse !== undefined) {
      await this.#observeResponse(observation);
    }
  }

  #touchCache(key: string, value: CachedResponse): void {
    this.#cache.delete(key);
    this.#cache.set(key, value);
    while (this.#cache.size > this.#maxCachedResponses) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.#cache.delete(oldest);
    }
  }
}

function page<T>(items: readonly T[], response: JsonResponse<unknown>): GitHubPage<T> {
  return {
    items,
    nextPage: response.nextPage,
    ...(response.rateLimit === undefined ? {} : { rateLimit: response.rateLimit }),
  };
}

function mapRepository(value: unknown, requestUrl: string): GitHubRepositorySnapshot {
  const object = expectObject(value, "response", requestUrl);
  return {
    githubRepositoryId: readPositiveInteger(object.id, "response.id", requestUrl),
    githubNodeId: readString(object.node_id, "response.node_id", requestUrl),
    fullName: readString(object.full_name, "response.full_name", requestUrl),
    htmlUrl: readString(object.html_url, "response.html_url", requestUrl),
    defaultBranch: readString(object.default_branch, "response.default_branch", requestUrl),
    isPrivate: readBoolean(object.private, "response.private", requestUrl),
  };
}

function mapSearchItem(value: unknown, path: string, requestUrl: string): GitHubSearchItem {
  const object = expectObject(value, path, requestUrl);
  return {
    kind:
      object.pull_request !== undefined && object.pull_request !== null ? "pull_request" : "issue",
    githubWorkItemId: readPositiveInteger(object.id, `${path}.id`, requestUrl),
    number: readPositiveInteger(object.number, `${path}.number`, requestUrl),
  };
}

function mapIssue(value: unknown, requestUrl: string): GitHubIssueSnapshot {
  const object = expectObject(value, "response", requestUrl);
  return {
    kind: "issue",
    ...mapWorkItemBase(object, requestUrl),
  };
}

function mapPullRequest(value: unknown, requestUrl: string): GitHubPullRequestSnapshot {
  const object = expectObject(value, "response", requestUrl);
  const base = expectObject(object.base, "response.base", requestUrl);
  const head = expectObject(object.head, "response.head", requestUrl);
  return {
    kind: "pull_request",
    ...mapWorkItemBase(object, requestUrl),
    isDraft: readBoolean(object.draft, "response.draft", requestUrl),
    baseSha: readString(base.sha, "response.base.sha", requestUrl),
    headSha: readString(head.sha, "response.head.sha", requestUrl),
  };
}

function mapWorkItemBase(object: JsonObject, requestUrl: string) {
  const state = readString(object.state, "response.state", requestUrl);
  if (state !== "open" && state !== "closed") {
    invalidResponse("response.state must be open or closed.", requestUrl);
  }
  return {
    githubWorkItemId: readPositiveInteger(object.id, "response.id", requestUrl),
    githubNodeId: readString(object.node_id, "response.node_id", requestUrl),
    number: readPositiveInteger(object.number, "response.number", requestUrl),
    title: readString(object.title, "response.title", requestUrl),
    body: readNullableString(object.body, "response.body", requestUrl),
    state,
    author: mapIdentity(object.user, "response.user", requestUrl),
    htmlUrl: readString(object.html_url, "response.html_url", requestUrl),
    createdAt: readDateTime(object.created_at, "response.created_at", requestUrl),
    updatedAt: readDateTime(object.updated_at, "response.updated_at", requestUrl),
    closedAt: readNullableDateTime(object.closed_at, "response.closed_at", requestUrl),
  } as const;
}

function mapTimelineEvent(
  value: unknown,
  path: string,
  requestUrl: string,
): GitHubTimelineEvent | null {
  const object = expectObject(value, path, requestUrl);
  const action = object.event;
  if (
    action !== "assigned" &&
    action !== "unassigned" &&
    action !== "review_requested" &&
    action !== "review_request_removed"
  ) {
    return null;
  }
  const targetValue =
    action === "assigned" || action === "unassigned" ? object.assignee : object.requested_reviewer;
  return {
    githubEventId: readEventId(object, path, requestUrl),
    action,
    actor:
      object.actor === null || object.actor === undefined
        ? null
        : mapIdentity(object.actor, `${path}.actor`, requestUrl),
    target:
      targetValue === null || targetValue === undefined
        ? null
        : mapIdentity(targetValue, `${path}.target`, requestUrl),
    occurredAt: readDateTime(object.created_at, `${path}.created_at`, requestUrl),
  };
}

function readEventId(object: JsonObject, path: string, requestUrl: string): string | number | null {
  if (typeof object.id === "number" && Number.isSafeInteger(object.id) && object.id > 0) {
    return object.id;
  }
  if (typeof object.node_id === "string" && object.node_id.length > 0) {
    return object.node_id;
  }
  if (object.id === null || object.id === undefined) {
    return null;
  }
  invalidResponse(`${path}.id must be a positive safe integer when present.`, requestUrl);
}

function mapIdentity(value: unknown, path: string, requestUrl: string): GitHubIdentitySnapshot {
  const object = expectObject(value, path, requestUrl);
  const accountType = mapAccountType(object.type);
  const githubNodeId = readOptionalString(object.node_id, `${path}.node_id`, requestUrl);
  const avatarUrl = readOptionalString(object.avatar_url, `${path}.avatar_url`, requestUrl);
  return {
    githubUserId: readPositiveInteger(object.id, `${path}.id`, requestUrl),
    login: readString(object.login, `${path}.login`, requestUrl),
    ...(accountType === undefined ? {} : { accountType }),
    ...(githubNodeId === undefined ? {} : { githubNodeId }),
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
  };
}

function mapAccountType(value: unknown): GitHubIdentitySnapshot["accountType"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  switch (value.toLowerCase()) {
    case "user":
      return "user";
    case "bot":
      return "bot";
    case "app":
      return "app";
    default:
      return undefined;
  }
}

function repositoryApiPath(fullName: string): string {
  const parts = fullName.split("/");
  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        part.length === 0 || part === "." || part === ".." || !/^[A-Za-z0-9_.-]+$/u.test(part),
    )
  ) {
    throw new TypeError("repositoryFullName must be a GitHub owner/name pair.");
  }
  return `repos/${parts.map((part) => encodeURIComponent(part)).join("/")}`;
}

function responseUrl(baseUrl: URL, path: string, query?: URLSearchParams): string {
  const url = new URL(path, baseUrl);
  if (query !== undefined) {
    url.search = query.toString();
  }
  return url.href;
}

function normalizeBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.endsWith("/") ? value : `${value}/`);
  } catch {
    throw new TypeError("baseUrl must be an absolute HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError("baseUrl must be an absolute HTTPS URL without credentials or a query.");
  }
  return url;
}

function validateHeaderValue(value: string, name: string): void {
  if (value.trim().length === 0 || value.includes("\r") || value.includes("\n")) {
    throw new TypeError(`${name} must be a non-empty HTTP header value.`);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function pageSize(value: number): number {
  const size = positiveInteger(value, "perPage");
  if (size > 100) {
    throw new RangeError("perPage must not exceed 100.");
  }
  return size;
}

function readRateLimit(headers: Headers): GitHubRateLimitState | undefined {
  const remainingValue = headers.get("x-ratelimit-remaining");
  const resetValue = headers.get("x-ratelimit-reset");
  if (remainingValue === null || resetValue === null) {
    return undefined;
  }
  const remaining = Number(remainingValue);
  const resetSeconds = Number(resetValue);
  if (
    !Number.isSafeInteger(remaining) ||
    remaining < 0 ||
    !Number.isSafeInteger(resetSeconds) ||
    resetSeconds < 0
  ) {
    return undefined;
  }
  const retryAfterValue = headers.get("retry-after");
  const retryAfterSeconds = retryAfterValue === null ? Number.NaN : Number(retryAfterValue);
  const retryAfterMs =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? Math.ceil(retryAfterSeconds * 1_000)
      : undefined;
  return {
    resource: headers.get("x-ratelimit-resource") ?? "core",
    remaining,
    resetAt: new Date(resetSeconds * 1_000).toISOString(),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function readNextPage(linkHeader: string | null, requestUrl: string): number | null {
  if (linkHeader === null) {
    return null;
  }
  for (const section of linkHeader.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"\s*$/u.exec(section);
    if (match === null || !match[2]?.split(/\s+/u).includes("next")) {
      continue;
    }
    try {
      const pageValue = new URL(match[1] ?? "").searchParams.get("page");
      const nextPage = Number(pageValue);
      if (!Number.isSafeInteger(nextPage) || nextPage <= 0) {
        throw new Error("invalid page");
      }
      return nextPage;
    } catch {
      throw new InvalidGitHubRestResponseError(
        "GitHub pagination Link header contains an invalid next relation.",
        requestUrl,
      );
    }
  }
  return null;
}

async function readErrorBody(response: Response): Promise<string | null> {
  try {
    const body = await response.text();
    return body.length === 0 ? null : body.slice(0, MAX_ERROR_BODY_LENGTH);
  } catch {
    return null;
  }
}

function redactSecret(value: string | null, secret: string): string | null {
  return value?.replaceAll(secret, "[REDACTED]") ?? null;
}

function expectObject(value: unknown, path: string, requestUrl: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidResponse(`${path} must be an object.`, requestUrl);
  }
  return value as JsonObject;
}

function expectArray(value: unknown, path: string, requestUrl: string): unknown[] {
  if (!Array.isArray(value)) {
    invalidResponse(`${path} must be an array.`, requestUrl);
  }
  return value;
}

function readString(value: unknown, path: string, requestUrl: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalidResponse(`${path} must be a non-empty string.`, requestUrl);
  }
  return value;
}

function readOptionalString(value: unknown, path: string, requestUrl: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return readString(value, path, requestUrl);
}

function readNullableString(value: unknown, path: string, requestUrl: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    invalidResponse(`${path} must be a string or null.`, requestUrl);
  }
  return value;
}

function readPositiveInteger(value: unknown, path: string, requestUrl: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    invalidResponse(`${path} must be a positive safe integer.`, requestUrl);
  }
  return value;
}

function readNonNegativeInteger(value: unknown, path: string, requestUrl: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidResponse(`${path} must be a non-negative safe integer.`, requestUrl);
  }
  return value;
}

function readBoolean(value: unknown, path: string, requestUrl: string): boolean {
  if (typeof value !== "boolean") {
    invalidResponse(`${path} must be a boolean.`, requestUrl);
  }
  return value;
}

function readDateTime(value: unknown, path: string, requestUrl: string): string {
  const dateTime = readString(value, path, requestUrl);
  if (!Number.isFinite(Date.parse(dateTime))) {
    invalidResponse(`${path} must be an ISO-8601 timestamp.`, requestUrl);
  }
  return dateTime;
}

function readNullableDateTime(value: unknown, path: string, requestUrl: string): string | null {
  if (value === null) {
    return null;
  }
  return readDateTime(value, path, requestUrl);
}

function invalidResponse(message: string, requestUrl: string): never {
  throw new InvalidGitHubRestResponseError(message, requestUrl);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
