import type { NormalizedSchedulingEvent } from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";

import { reconcileGitHubPolling } from "../../dist/github/poller.js";
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

const pullRequestPayload = {
  id: 4092547032,
  node_id: "PR_kwDOQ37W1M7z70_Y",
  number: 1,
  title: "Recorded pull request identity fixture",
  body: null,
  state: "open",
  user: { id: 42196638, login: "moooyo", type: "User" },
  html_url: "https://github.com/moooyo/kiss-translator-m3/pull/1",
  created_at: "2026-09-05T00:00:00Z",
  updated_at: "2026-09-05T01:00:00Z",
  closed_at: null,
  draft: false,
  base: { sha: "174d9b6a6f4f301c8d99378c44ce742d53b70446" },
  head: { sha: "d32380d8401a4d0d34f9622bfc87f676fd037214" },
};

const pullRequestSearchItem = {
  id: 4930710068,
  node_id: pullRequestPayload.node_id,
  number: 1,
  pull_request: { url: "https://untrusted-response.example/pulls/1" },
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
      if (new URL(String(input)).pathname.endsWith("/pulls/20")) {
        return Response.json({ ...pullRequestPayload, id: 20, node_id: "PR_20", number: 20 });
      }
      return new Response(
        JSON.stringify({
          total_count: 2,
          incomplete_results: false,
          items: [
            { id: 10, number: 10 },
            {
              id: 20,
              node_id: "PR_20",
              number: 20,
              pull_request: { url: "https://api.github.test/pulls/20" },
            },
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

    expect(result.items).toMatchObject([
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

  it("reconciles distinct issue-search and pull-request IDs using the canonical PR identity", async () => {
    const requestedUrls: string[] = [];
    const events: NormalizedSchedulingEvent[] = [];
    const client = new GitHubRestClient({
      token: "fixture-token",
      userAgent: "agentic-review-tests/1.0",
      fetchImplementation: async (input) => {
        const url = new URL(String(input));
        requestedUrls.push(url.href);
        if (url.pathname === "/repos/moooyo/kiss-translator-m3") {
          return Response.json({
            ...repositoryPayload,
            id: 1132386004,
            full_name: "moooyo/kiss-translator-m3",
            html_url: "https://github.com/moooyo/kiss-translator-m3",
            default_branch: "dev",
          });
        }
        if (url.pathname === "/search/issues") {
          const assigned = url.searchParams.get("q")?.includes("assignee:") === true;
          return Response.json({
            total_count: assigned ? 1 : 0,
            incomplete_results: false,
            items: assigned ? [pullRequestSearchItem] : [],
          });
        }
        if (url.pathname === "/repos/moooyo/kiss-translator-m3/pulls/1") {
          return Response.json(pullRequestPayload);
        }
        if (url.pathname === "/repos/moooyo/kiss-translator-m3/issues/1/timeline") {
          return Response.json([
            {
              id: 10001,
              event: "assigned",
              actor: pullRequestPayload.user,
              assignee: pullRequestPayload.user,
              created_at: "2026-09-05T01:00:00Z",
            },
          ]);
        }
        throw new Error("Unexpected fixture request.");
      },
    });
    const result = await reconcileGitHubPolling({
      client,
      repository: { githubRepositoryId: 1132386004, fullName: "moooyo/kiss-translator-m3" },
      reviewer: { githubUserId: 42196638, login: "moooyo" },
      ingest: (event) => {
        events.push(event);
      },
      now: () => new Date("2026-09-05T02:00:00Z"),
    });

    expect(result.uniqueWorkItemCount).toBe(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "request_opened",
          requestKind: "assignment",
          workItem: expect.objectContaining({ githubWorkItemId: 4092547032, number: 1 }),
        }),
      ]),
    );
    expect(result.nextActiveProjection.workItems[0]?.workItem.githubWorkItemId).toBe(4092547032);
    expect(requestedUrls.filter((url) => new URL(url).pathname.endsWith("/pulls/1"))).toHaveLength(
      1,
    );
    expect(requestedUrls.every((url) => new URL(url).origin === "https://api.github.com")).toBe(
      true,
    );
  });

  it.each([
    { field: "number", replacement: { number: 2 } },
    { field: "node ID", replacement: { node_id: "PR_different" } },
  ])(
    "rejects PR details whose $field does not match the search result",
    async ({ replacement }) => {
      const client = new GitHubRestClient({
        token: "fixture-token",
        userAgent: "agentic-review-tests/1.0",
        fetchImplementation: async (input) =>
          Response.json(
            new URL(String(input)).pathname === "/search/issues"
              ? { total_count: 1, incomplete_results: false, items: [pullRequestSearchItem] }
              : { ...pullRequestPayload, ...replacement },
          ),
      });

      await expect(
        client.searchIssuesAndPullRequests({
          repositoryFullName: "moooyo/kiss-translator-m3",
          query: "repo:moooyo/kiss-translator-m3 is:open assignee:moooyo",
          page: 1,
          perPage: 100,
        }),
      ).rejects.toThrow(/does not match its pull request detail identity/u);
    },
  );

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
