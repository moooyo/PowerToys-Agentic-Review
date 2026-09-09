import type {
  PublicationIntent,
  PublicationPayload,
  PublicationReviewEvent,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  GitHubPublicationClient,
  type GitHubPublicationClientOptions,
} from "./publication-client.js";
import { createPullRequestRevisionKey } from "./revision-key.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const now = "2026-09-07T00:00:00.000Z";
const publisherId = 73;
const repository = { id: 11, full_name: "fixture/example" };
const pull = {
  id: 22,
  number: 3,
  state: "open",
  head: { sha: headSha },
  base: { sha: baseSha },
  html_url: "https://github.com/fixture/example/pull/3",
};
const issue = {
  id: 22,
  number: 3,
  state: "open",
  title: "Synthetic issue",
  body: null,
  updated_at: "2026-09-07T00:00:00Z",
  html_url: "https://github.com/fixture/example/issues/3",
};
type Request = { url: URL; init: RequestInit };

function intent(
  kind: "pull_request" | "issue" = "pull_request",
  event: PublicationReviewEvent = "COMMENT",
): PublicationIntent {
  const publicationId = "publication-fixture";
  const semanticBody = "Approved synthetic report.\n";
  const semanticSha256 = sha256(semanticBody);
  const body = `${semanticBody}\n<!-- agentic-review-publication:${publicationId} semantic-sha256:${semanticSha256} -->`;
  const payload: PublicationPayload =
    kind === "pull_request"
      ? { kind: "pull_request_review", body, commitId: headSha, event }
      : { kind: "issue_comment", body };
  const actor = { issuer: "https://identity.example", subject: "synthetic-operator" };
  const revisionKey =
    kind === "pull_request"
      ? createPullRequestRevisionKey(baseSha, headSha)
      : sha256(JSON.stringify([issue.title, issue.body, issue.state, issue.updated_at]));
  const binding = {
    repositoryId: "repo-fixture",
    reviewRunId: "run-fixture",
    workItemId: "item-fixture",
    selectedDecisionId: "decision-fixture",
    selectedDecisionVersion: 1,
    decisionContextVersion: 1,
    revisionKey,
    planDigest: "c".repeat(64),
    resultSetDigest: "d".repeat(64),
  };
  const decisionBase = {
    id: binding.selectedDecisionId,
    changeId: "decision-change",
    actor,
    previousVersion: 0,
    version: 1,
    createdAt: now,
    reason: "Synthetic approval",
    supersedesDecisionId: null,
    targetDecisionId: null,
    repositoryId: binding.repositoryId,
    reviewRunId: binding.reviewRunId,
    workItemId: binding.workItemId,
    revisionKey,
    planDigest: binding.planDigest,
    resultSetDigest: binding.resultSetDigest,
  };
  const policyBase = {
    policyVersion: "required-checks-and-p0-p1-v1" as const,
    blockingFindingCount: 0,
    reasonCount: 0,
    reasonCodes: [],
    reasonCodesTruncated: false,
  };
  const decision: PublicationIntent["decision"] =
    kind === "pull_request"
      ? {
          ...decisionBase,
          workItemKind: "pull_request",
          action:
            event === "APPROVE"
              ? "approve"
              : event === "REQUEST_CHANGES"
                ? "request_changes"
                : "comment",
          policyAtDecision: { ...policyBase, applicable: true, eligible: true },
        }
      : {
          ...decisionBase,
          workItemKind: "issue",
          action: "comment",
          policyAtDecision: { ...policyBase, applicable: false, eligible: null },
        };
  return {
    schemaVersion: "PublicationIntentV1",
    publicationId,
    rendererVersion: "publication-renderer-v1",
    policyVersion: 1,
    binding,
    decision,
    target: {
      githubRepositoryId: 11,
      githubWorkItemId: 22,
      fullName: "fixture/example",
      number: 3,
      kind,
    },
    payload,
    payloadSha256: sha256(canonicalJson(payload)),
    semanticSha256,
    publisherGitHubUserId: publisherId,
    actor,
    createdAt: now,
    confirmationChangeId: "confirmation-fixture",
  };
}

function remote(value: PublicationIntent, id = 101): Record<string, unknown> {
  const common = { id, user: { id: publisherId }, body: value.payload.body };
  return value.payload.kind === "pull_request_review"
    ? {
        ...common,
        commit_id: headSha,
        state: { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" }[
          value.payload.event
        ],
        submitted_at: "2026-09-07T00:00:00Z",
        html_url: `https://github.com/fixture/example/pull/3#pullrequestreview-${id}`,
      }
    : {
        ...common,
        created_at: "2026-09-07T00:00:00Z",
        html_url: `https://github.com/fixture/example/issues/3#issuecomment-${id}`,
        issue_url: "https://api.github.com/repos/fixture/example/issues/3",
      };
}

function harness(
  handler: (request: Request) => Response | Promise<Response>,
  options: Partial<GitHubPublicationClientOptions> = {},
) {
  const requests: Request[] = [];
  const client = new GitHubPublicationClient({
    token: "synthetic-publication-token",
    expectedGitHubUserId: publisherId,
    now: () => Date.parse(now),
    ...options,
    fetchImplementation: async (input, init) => {
      const request = { url: new URL(String(input)), init: init ?? {} };
      requests.push(request);
      return handler(request);
    },
  });
  return { client, requests };
}

function identityResponse(
  request: Request,
  workItem: Record<string, unknown> = pull,
): Response | undefined {
  if (request.url.pathname === "/user") return Response.json({ id: publisherId });
  if (request.url.pathname === "/repos/fixture/example") return Response.json(repository);
  if (/\/(?:pulls|issues)\/3$/u.test(request.url.pathname)) return Response.json(workItem);
  return undefined;
}

describe("GitHubPublicationClient preflight", () => {
  it.each(["pull_request", "issue"] as const)(
    "verifies frozen %s identity and the ingestion revision formula",
    async (kind) => {
      const { client, requests } = harness(
        (request) =>
          identityResponse(request, kind === "issue" ? issue : pull) ?? Response.json({}),
      );
      expect(await client.preflight(intent(kind))).toEqual({ status: "ready" });
      expect(requests).toHaveLength(3);
      for (const request of requests) {
        expect(request.url.origin).toBe("https://api.github.com");
        expect(request.init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
        expect(new Headers(request.init.headers).get("authorization")).toBe(
          "Bearer synthetic-publication-token",
        );
      }
    },
  );

  it("rejects changed configured publisher without any network call", async () => {
    const { client, requests } = harness(() => Response.json({}), { expectedGitHubUserId: 99 });
    expect(await client.preflight(intent())).toMatchObject({
      status: "blocked",
      failure: { code: "publisher_identity_mismatch" },
    });
    expect(requests).toHaveLength(0);
  });

  it.each([
    { path: "/user", body: { id: 99 }, code: "publisher_identity_mismatch", calls: 1 },
    {
      path: "/repos/fixture/example",
      body: { ...repository, id: 99 },
      code: "target_identity_mismatch",
      calls: 2,
    },
    {
      path: "/repos/fixture/example",
      body: { ...repository, full_name: "fixture/other" },
      code: "target_identity_mismatch",
      calls: 2,
    },
    {
      path: "/repos/fixture/example/pulls/3",
      body: { ...pull, id: 99 },
      code: "target_identity_mismatch",
      calls: 3,
    },
    {
      path: "/repos/fixture/example/pulls/3",
      body: { ...pull, number: 4 },
      code: "target_identity_mismatch",
      calls: 3,
    },
    {
      path: "/repos/fixture/example/pulls/3",
      body: { ...pull, html_url: "https://github.com/fixture/other/pull/3" },
      code: "target_identity_mismatch",
      calls: 3,
    },
    {
      path: "/repos/fixture/example/pulls/3",
      body: { ...pull, state: "closed" },
      code: "source_changed",
      calls: 3,
    },
    {
      path: "/repos/fixture/example/pulls/3",
      body: { ...pull, head: { sha: "e".repeat(40) } },
      code: "source_changed",
      calls: 3,
    },
    {
      path: "/repos/fixture/example/pulls/3",
      body: { ...pull, base: { sha: "e".repeat(40) } },
      code: "source_changed",
      calls: 3,
    },
  ])("blocks a changed identity or source: $code ($path)", async ({ path, body, code, calls }) => {
    const { client, requests } = harness((request) =>
      request.url.pathname === path
        ? Response.json(body)
        : (identityResponse(request) ?? Response.json({})),
    );
    expect(await client.preflight(intent())).toMatchObject({
      status: "blocked",
      failure: { code },
    });
    expect(requests).toHaveLength(calls);
  });

  it.each([{ title: "Changed" }, { body: "Changed" }, { updated_at: "2026-09-07T01:00:00Z" }])(
    "blocks an issue revision change: %j",
    async (change) => {
      const { client } = harness(
        (request) => identityResponse(request, { ...issue, ...change }) ?? Response.json({}),
      );
      expect(await client.preflight(intent("issue"))).toMatchObject({
        status: "blocked",
        failure: { code: "source_changed" },
      });
    },
  );

  it("rejects a pull request represented through the issues endpoint", async () => {
    const { client } = harness(
      (request) => identityResponse(request, { ...issue, pull_request: {} }) ?? Response.json({}),
    );
    expect(await client.preflight(intent("issue"))).toMatchObject({
      status: "blocked",
      failure: { code: "target_identity_mismatch" },
    });
  });

  it("blocks changed payloads before publishing", async () => {
    const value = intent();
    value.payload.body += "tampered";
    const { client, requests } = harness(() => Response.json({}));
    expect(await client.publish(value)).toMatchObject({
      status: "blocked",
      failure: { code: "preflight_failed" },
    });
    expect(requests).toHaveLength(0);
  });
});

describe("GitHubPublicationClient publication", () => {
  it.each(["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const)(
    "sends exactly the approved %s review in one POST",
    async (event) => {
      const value = intent("pull_request", event);
      const { client, requests } = harness(() => Response.json(remote(value)));
      expect(await client.publish(value)).toMatchObject({
        status: "published",
        remoteReceipt: {
          kind: "pull_request_review",
          githubId: 101,
          publisherGitHubUserId: publisherId,
          commitId: headSha,
          event,
          createdAt: now,
        },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url.href).toBe(
        "https://api.github.com/repos/fixture/example/pulls/3/reviews",
      );
      expect(requests[0]?.init.method).toBe("POST");
      expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
        commit_id: headSha,
        event,
        body: value.payload.body,
      });
    },
  );

  it("sends exactly one issue comment and requires its 201 receipt", async () => {
    const value = intent("issue");
    const { client, requests } = harness(() => Response.json(remote(value), { status: 201 }));
    expect(await client.publish(value)).toMatchObject({
      status: "published",
      remoteReceipt: { kind: "issue_comment", githubId: 101 },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toBe("/repos/fixture/example/issues/3/comments");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ body: value.payload.body });
  });

  it.each([
    { id: 0 },
    { user: { id: 99 } },
    { body: "edited" },
    { commit_id: baseSha },
    { state: "PENDING" },
    { state: "DISMISSED" },
    { submitted_at: null },
    { html_url: "https://github.com.evil.test/fixture/example/pull/3#pullrequestreview-101" },
    { html_url: "https://github.com/fixture/other/pull/3#pullrequestreview-101" },
  ])("leaves a mismatched success unknown: %j", async (change) => {
    const value = intent();
    const { client, requests } = harness(() => Response.json({ ...remote(value), ...change }));
    expect(await client.publish(value)).toMatchObject({
      status: "unknown",
      failure: { code: "ambiguous_delivery" },
    });
    expect(requests).toHaveLength(1);
  });

  it.each([200, 202, 204, 408, 500, 502, 503])(
    "never retries an ambiguous status %s",
    async (status) => {
      const { client, requests } = harness(
        () => new Response(status === 204 ? null : "{}", { status }),
      );
      expect(await client.publish(intent("issue"))).toMatchObject({ status: "unknown" });
      expect(requests).toHaveLength(1);
    },
  );

  it.each([401, 403, 404, 410, 422])(
    "records a definite rejection %s without retry or secret echo",
    async (status) => {
      const { client, requests } = harness(() =>
        Response.json({ message: "synthetic-publication-token" }, { status }),
      );
      const outcome = await client.publish(intent());
      expect(outcome).toMatchObject({
        status: status === 401 || status === 403 ? "blocked" : "failed",
        failure: { code: "github_rejected" },
      });
      expect(JSON.stringify(outcome)).not.toContain("synthetic-publication-token");
      expect(requests).toHaveLength(1);
    },
  );

  it("does not retry a network exception and does not disclose its message", async () => {
    const { client, requests } = harness(() => {
      throw new Error("synthetic-publication-token");
    });
    const outcome = await client.publish(intent());
    expect(outcome).toMatchObject({ status: "unknown" });
    expect(JSON.stringify(outcome)).not.toContain("synthetic-publication-token");
    expect(requests).toHaveLength(1);
  });

  it.each([
    { status: 429, headers: { "retry-after": "2.5" }, body: {}, wait: 2_500 },
    {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Date.parse(now) / 1_000 + 120),
        "retry-after": "5",
      },
      body: {},
      wait: 120_000,
    },
    {
      status: 403,
      headers: {},
      body: { message: "You have exceeded a secondary rate limit." },
      wait: 60_000,
    },
  ])("maps bounded cooldown metadata without retrying", async ({ status, headers, body, wait }) => {
    const { client, requests } = harness(() => Response.json(body, { status, headers }));
    expect(await client.publish(intent())).toMatchObject({
      status: "failed",
      failure: { code: "rate_limited" },
      retryAfterMs: wait,
    });
    expect(requests).toHaveLength(1);
  });

  it.each(["NaN", "99999999999999999999999", "-1", "Wed, 21 Oct 2026 07:28:00 GMT"])(
    "blocks unbounded or unsupported cooldown %s",
    async (retry) => {
      const { client } = harness(() =>
        Response.json({}, { status: 429, headers: { "retry-after": retry } }),
      );
      expect(await client.publish(intent())).toEqual({
        status: "blocked",
        failure: {
          code: "rate_limited",
          message: "GitHub rejected the request due to rate limiting.",
        },
      });
    },
  );
});

describe("GitHubPublicationClient read-only reconciliation", () => {
  it.each(["pull_request", "issue"] as const)(
    "finds an exact %s receipt after a lost response across pages",
    async (kind) => {
      const value = intent(kind);
      const path = `/repos/fixture/example/${kind === "pull_request" ? "pulls/3/reviews" : "issues/3/comments"}`;
      const { client, requests } = harness(
        (request) =>
          identityResponse(
            request,
            kind === "pull_request"
              ? { ...pull, state: "closed", head: { sha: baseSha } }
              : { ...issue, state: "closed" },
          ) ??
          (request.url.searchParams.get("page") === "1"
            ? Response.json([{ id: 90, body: "Unrelated" }], {
                headers: {
                  link: `<https://api.github.com${path}?per_page=100&page=2>; rel="next"`,
                },
              })
            : Response.json([remote(value)])),
      );
      expect(await client.reconcile(value)).toMatchObject({
        status: "published",
        remoteReceipt: { githubId: 101 },
      });
      expect(requests).toHaveLength(5);
      expect(requests.every((request) => request.init.method === "GET")).toBe(true);
    },
  );

  it.each([
    { rows: () => [], code: "reconciliation_no_match" },
    {
      rows: (value: PublicationIntent) => [remote(value), remote(value, 102)],
      code: "reconciliation_multiple_matches",
    },
    {
      rows: (value: PublicationIntent) => [
        { ...remote(value), body: `${value.payload.body}\nedited` },
      ],
      code: "reconciliation_mismatch",
    },
    {
      rows: (value: PublicationIntent) => [{ ...remote(value), state: "DISMISSED" }],
      code: "reconciliation_mismatch",
    },
    {
      rows: (value: PublicationIntent) => [{ ...remote(value), user: { id: 999 } }],
      code: "reconciliation_mismatch",
    },
    {
      rows: (value: PublicationIntent) => [{ ...remote(value), commit_id: baseSha }],
      code: "reconciliation_mismatch",
    },
  ])("keeps uncertainty for $code and never writes", async ({ rows, code }) => {
    const value = intent();
    const { client, requests } = harness(
      (request) => identityResponse(request) ?? Response.json(rows(value)),
    );
    expect(await client.reconcile(value)).toMatchObject({ status: "unknown", failure: { code } });
    expect(requests.every((request) => request.init.method === "GET")).toBe(true);
  });

  it.each([
    '<https://evil.test/repos/fixture/example/pulls/3/reviews?per_page=100&page=2>; rel="next"',
    '<http://api.github.com/repos/fixture/example/pulls/3/reviews?per_page=100&page=2>; rel="next"',
    '<https://api.github.com/repos/fixture/other/pulls/3/reviews?per_page=100&page=2>; rel="next"',
    '<https://api.github.com/repos/fixture/example/pulls/3/reviews?per_page=100&page=1>; rel="next"',
    '<https://api.github.com/repos/fixture/example/pulls/3/reviews?per_page=100&page=3>; rel="next"',
    '<https://api.github.com/repos/fixture/example/pulls/3/reviews?per_page=100&page=2&page=3>; rel="next"',
    '<https://api.github.com/repos/fixture/example/pulls/3/reviews?per_page=100&page=2&token=x>; rel="next"',
    '<https://user:password@api.github.com/repos/fixture/example/pulls/3/reviews?per_page=100&page=2>; rel="next"',
    '<https://api.github.com/repos/fixture/example/pulls/3/reviews?per_page=100&page=2#fragment>; rel="next"',
    "malformed",
  ])("rejects unsafe or incomplete pagination: %s", async (link) => {
    const value = intent();
    const { client, requests } = harness(
      (request) =>
        identityResponse(request) ?? Response.json([remote(value)], { headers: { link } }),
    );
    expect(await client.reconcile(value)).toMatchObject({
      status: "unknown",
      failure: { code: "reconciliation_incomplete" },
    });
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.url.origin === "https://api.github.com")).toBe(true);
  });

  it("never confirms an early match after a later page fails", async () => {
    const value = intent();
    const { client } = harness(
      (request) =>
        identityResponse(request) ??
        (request.url.searchParams.get("page") === "1"
          ? Response.json([remote(value)], {
              headers: {
                link: '<https://api.github.com/repos/fixture/example/pulls/3/reviews?per_page=100&page=2>; rel="next"',
              },
            })
          : Response.json({}, { status: 503 })),
    );
    expect(await client.reconcile(value)).toMatchObject({
      status: "unknown",
      failure: { code: "reconciliation_incomplete" },
    });
  });

  it("bounds reconciliation at 100 pages", async () => {
    const { client, requests } = harness(
      (request) =>
        identityResponse(request) ??
        Response.json([], {
          headers: {
            link: `<https://api.github.com/repos/fixture/example/pulls/3/reviews?per_page=100&page=${Number(request.url.searchParams.get("page")) + 1}>; rel="next"`,
          },
        }),
    );
    expect(await client.reconcile(intent())).toMatchObject({
      status: "unknown",
      failure: { code: "reconciliation_incomplete" },
    });
    expect(requests).toHaveLength(103);
  });

  it("bounds streamed response bytes even without content-length", async () => {
    let cancelled = false;
    const { client } = harness(
      (request) =>
        identityResponse(request) ??
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    expect(await client.reconcile(intent())).toMatchObject({
      status: "unknown",
      failure: { code: "reconciliation_incomplete" },
    });
    expect(cancelled).toBe(true);
  });

  it("bounds a stalled response body by the reconciliation deadline", async () => {
    const { client, requests } = harness(
      (request) => identityResponse(request) ?? new Response(new ReadableStream()),
      { requestTimeoutMs: 100, reconciliationTimeoutMs: 5 },
    );
    expect(await client.reconcile(intent())).toMatchObject({
      status: "unknown",
      failure: { code: "reconciliation_incomplete" },
    });
    expect(requests.every((request) => request.init.method === "GET")).toBe(true);
  });

  it("preserves unknown when credentials change during recovery", async () => {
    const { client, requests } = harness(() => Response.json({ id: 99 }));
    expect(await client.reconcile(intent())).toMatchObject({
      status: "unknown",
      failure: { code: "reconciliation_incomplete" },
    });
    expect(requests).toHaveLength(1);
  });

  it("does not dispatch an already aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, requests } = harness(() => Response.json({}));
    expect(await client.publish(intent(), controller.signal)).toMatchObject({ status: "unknown" });
    expect(requests).toHaveLength(0);
  });
});
