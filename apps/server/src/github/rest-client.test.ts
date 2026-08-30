import { describe, expect, it } from "vitest";

import {
  GitHubRestApiError,
  GitHubRestClient,
  type GitHubRestResponseObservation,
} from "../../dist/github/rest-client.js";

const repositoryPayload = {
  id: 1,
  node_id: "R_1",
  full_name: "microsoft/PowerToys",
  html_url: "https://github.com/microsoft/PowerToys",
  default_branch: "main",
  private: false,
};

describe("GitHubRestClient", () => {
  it("injects authentication/version headers and maps pagination plus rate limits", async () => {
    const token = "secret-token-value";
    const requests: Array<{ url: string; headers: Headers; signal: AbortSignal | null }> = [];
    const observations: GitHubRestResponseObservation[] = [];
    const fetchImplementation: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        signal: init?.signal instanceof AbortSignal ? init.signal : null,
      });
      return new Response(
        JSON.stringify({
          total_count: 2,
          incomplete_results: false,
          items: [
            { id: 10, number: 10 },
            { id: 20, number: 20, pull_request: { url: "https://api.github.test/pulls/20" } },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            link: '<https://api.github.test/search/issues?q=test&page=2&per_page=2>; rel="next", <https://api.github.test/search/issues?q=test&page=3&per_page=2>; rel="last"',
            "x-ratelimit-resource": "search",
            "x-ratelimit-remaining": "7",
            "x-ratelimit-reset": "1788091500",
            "retry-after": "1.5",
          },
        },
      );
    };
    const client = new GitHubRestClient({
      token,
      userAgent: "agentic-review-tests/1.0",
      baseUrl: "https://api.github.test/",
      fetchImplementation,
      observeResponse: (observation) => observations.push(observation),
    });
    const controller = new AbortController();

    const result = await client.searchIssuesAndPullRequests({
      repositoryFullName: "microsoft/PowerToys",
      query: "repo:microsoft/PowerToys is:open assignee:reviewer",
      page: 1,
      perPage: 2,
      signal: controller.signal,
    });

    expect(result.items).toEqual([
      { kind: "issue", githubWorkItemId: 10, number: 10 },
      { kind: "pull_request", githubWorkItemId: 20, number: 20 },
    ]);
    expect(result.nextPage).toBe(2);
    expect(result.incomplete).toBe(false);
    expect(result.rateLimit).toMatchObject({
      resource: "search",
      remaining: 7,
      retryAfterMs: 1_500,
    });
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(requests[0]?.headers.get("user-agent")).toBe("agentic-review-tests/1.0");
    expect(requests[0]?.headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(requests[0]?.signal).toBe(controller.signal);
    expect(observations[0]).toMatchObject({ status: 200, notModified: false });
  });

  it("uses ETags and serves a 304 response from its bounded representation cache", async () => {
    const seenIfNoneMatch: Array<string | null> = [];
    let call = 0;
    const fetchImplementation: typeof fetch = async (_input, init) => {
      seenIfNoneMatch.push(new Headers(init?.headers).get("if-none-match"));
      call += 1;
      return call === 1
        ? new Response(JSON.stringify(repositoryPayload), {
            status: 200,
            headers: { "content-type": "application/json", etag: '"repository-v1"' },
          })
        : new Response(null, { status: 304 });
    };
    const client = new GitHubRestClient({
      token: "token",
      userAgent: "agentic-review-tests/1.0",
      fetchImplementation,
    });

    const first = await client.getRepository({ repositoryFullName: "microsoft/PowerToys" });
    const second = await client.getRepository({ repositoryFullName: "microsoft/PowerToys" });

    expect(second).toEqual(first);
    expect(seenIfNoneMatch).toEqual([null, '"repository-v1"']);
  });

  it("maps only scheduling-relevant timeline events", async () => {
    const fetchImplementation: typeof fetch = async () =>
      new Response(
        JSON.stringify([
          {
            id: 101,
            event: "assigned",
            actor: { id: 2, login: "assigner", type: "User" },
            assignee: { id: 3, login: "reviewer", type: "User" },
            created_at: "2026-08-30T10:00:00.000Z",
          },
          {
            id: 102,
            event: "commented",
            actor: { id: 2, login: "assigner", type: "User" },
            created_at: "2026-08-30T10:01:00.000Z",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const client = new GitHubRestClient({
      token: "token",
      userAgent: "agentic-review-tests/1.0",
      fetchImplementation,
    });

    const result = await client.listIssueTimelineEvents({
      repositoryFullName: "microsoft/PowerToys",
      number: 10,
      page: 1,
      perPage: 100,
    });

    expect(result.items).toEqual([
      {
        githubEventId: 101,
        action: "assigned",
        actor: { githubUserId: 2, login: "assigner", accountType: "user" },
        target: { githubUserId: 3, login: "reviewer", accountType: "user" },
        occurredAt: "2026-08-30T10:00:00.000Z",
      },
    ]);
  });

  it("never includes the bearer token in surfaced REST errors", async () => {
    const token = "do-not-disclose-this-token";
    const fetchImplementation: typeof fetch = async () =>
      new Response(JSON.stringify({ message: `Bad credentials: ${token}` }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    const client = new GitHubRestClient({
      token,
      userAgent: "agentic-review-tests/1.0",
      fetchImplementation,
    });

    const error = await client
      .getRepository({ repositoryFullName: "microsoft/PowerToys" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubRestApiError);
    expect(String(error)).not.toContain(token);
    expect(JSON.stringify(error)).not.toContain(token);
  });

  it("aborts a stalled request at the configured request timeout", async () => {
    const fetchImplementation: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          reject(new Error("Expected a request signal."));
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const client = new GitHubRestClient({
      token: "token",
      userAgent: "agentic-review-tests/1.0",
      fetchImplementation,
      requestTimeoutMs: 10,
    });

    const error = await client
      .getRepository({ repositoryFullName: "microsoft/PowerToys" })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "TimeoutError" });
  });
});
