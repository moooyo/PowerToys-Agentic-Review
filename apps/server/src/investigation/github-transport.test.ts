import { createHash } from "node:crypto";
import type {
  InvestigationActionIntentV1,
  InvestigationActionKind,
  InvestigationActionPayload,
  InvestigationCodeSuggestion,
  InvestigationSubjectV1,
} from "@agentic-review/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvestigationGitHubTransport } from "./github-transport.js";
import { contentDigest } from "./integrity.js";
import type {
  InvestigationOperatorPrincipal,
  InvestigationRepositoryRecord,
  InvestigationWorkItemRecord,
} from "./types.js";

type Json = Record<string, unknown>;
type RequestRecord = { method: string; path: string; body: Json | null; init: RequestInit };

const publisherId = 42;
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const branchSha = "c".repeat(40);
const mergedSha = "d".repeat(40);
const timestamp = "2026-09-15T08:00:00.000Z";
const basePath = "/repos/fixture/example";
const sourceText =
  'export function canRetry(status: string): boolean {\n  return status !== "running";\n}\n';
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const repository: InvestigationRepositoryRecord = {
  id: "repo-fixture",
  fullName: "fixture/example",
  githubRepositoryId: 700,
};
const actionCapabilities: InvestigationActionKind[] = [
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
const actor: InvestigationOperatorPrincipal = {
  id: "operator-fixture",
  displayName: "Synthetic operator",
  repositoryIds: [repository.id],
  permissions: ["action:prepare", "action:execute"],
  actionCapabilities,
  allowRepositoryExecution: false,
};
const remoteRepository = {
  id: repository.githubRepositoryId,
  full_name: repository.fullName,
  permissions: { push: true, maintain: false, admin: false, triage: true },
};
const remotePull = {
  id: 701,
  number: 3,
  state: "open",
  merged: false,
  locked: false,
  draft: false,
  user: { id: 99 },
  base: { sha: baseSha, ref: "main", repo: { id: repository.githubRepositoryId } },
  head: { sha: headSha, ref: "feature/retry", repo: { id: repository.githubRepositoryId } },
};
const remoteIssue = {
  id: 702,
  number: 5,
  state: "open",
  locked: false,
  title: "Synthetic report",
  body: "A synthetic report requiring investigation.",
  updated_at: timestamp,
  user: { id: 99 },
};

function workItem(kind: "pull_request" | "issue" = "pull_request"): InvestigationWorkItemRecord {
  const id = kind === "pull_request" ? "work-item-pr" : "work-item-issue";
  const revisionKey =
    kind === "pull_request"
      ? hash(`${baseSha}\0${headSha}`)
      : hash(
          JSON.stringify([
            remoteIssue.title,
            remoteIssue.body,
            remoteIssue.state,
            remoteIssue.updated_at,
          ]),
        );
  const subject: InvestigationSubjectV1 =
    kind === "pull_request"
      ? {
          id: "subject-original",
          kind: "original_pr",
          repositoryId: repository.id,
          workItemId: id,
          revisionKey,
          baseSha,
          headSha,
        }
      : {
          id: "subject-issue",
          kind: "issue_snapshot",
          repositoryId: repository.id,
          workItemId: id,
          revisionKey,
          snapshotDigest: "e".repeat(64),
        };
  return {
    id,
    repositoryId: repository.id,
    kind,
    number: kind === "pull_request" ? 3 : 5,
    title: "Synthetic work item",
    body: "Synthetic input",
    state: "open",
    subject,
    updatedAt: timestamp,
  };
}

function branchSubject(
  item: InvestigationWorkItemRecord,
): Extract<InvestigationSubjectV1, { kind: "remote_branch" }> {
  return {
    id: "subject-remote-branch",
    kind: "remote_branch",
    repositoryId: repository.id,
    workItemId: item.id,
    revisionKey: hash(`${baseSha}\0${branchSha}`),
    baseSha,
    headSha: branchSha,
    branch: "feature/verified",
    verifiedEvidenceRef: "evidence-branch-readback",
  };
}

function feedback(body = "Reviewed synthetic feedback."): InvestigationActionPayload {
  return { kind: "feedback", body, findingIds: [], drafts: [] };
}

function suggestionPayload(): Extract<InvestigationActionPayload, { kind: "feedback" }> {
  return {
    kind: "feedback",
    body: "Review the selected replacement.",
    findingIds: ["finding-retry"],
    drafts: [
      {
        id: "draft-retry",
        body: "Restrict retry admission to failed tasks.",
        suggestion: {
          subjectRef: "subject-original",
          path: "src/jobs/can-retry.ts",
          startLine: 2,
          endLine: 2,
          headSha,
          originalContentDigest: hash('  return status !== "running";'),
          replacement: '  return status === "failed";',
        },
      },
    ],
  };
}

function intent(
  action: InvestigationActionKind,
  payload: InvestigationActionPayload = feedback(),
  item = workItem(),
): InvestigationActionIntentV1 {
  return {
    schemaVersion: "InvestigationActionIntentV1",
    id: "intent-fixture",
    version: 2,
    idempotencyKey: "operation-fixture",
    action,
    repositoryId: repository.id,
    workItemId: item.id,
    actorId: actor.id,
    subjectRef: item.subject.id,
    expectedRevisionKey: item.subject.revisionKey,
    expectedHeadSha: item.kind === "pull_request" ? headSha : null,
    reportRef: null,
    payload,
    payloadDigest: contentDigest(payload),
    state: "executing",
    guards: [],
    createdAt: timestamp,
    confirmedAt: timestamp,
    result: null,
  };
}

function marker(value: InvestigationActionIntentV1): string {
  return `<!-- agentic-review-action:${value.id}:${value.payloadDigest} -->`;
}

function bodyWithMarker(value: InvestigationActionIntentV1, body: string): string {
  return `${body}\n\n${marker(value)}`;
}

function jsonResponse(value: unknown, status = 200): Response {
  return status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
}

function harness(
  options: {
    resolveSubject?: (
      id: string,
      repositoryId: string,
      workItemId: string,
    ) => Promise<InvestigationSubjectV1 | null>;
    mutate?: (request: RequestRecord) => Response | Promise<Response>;
  } = {},
) {
  const requests: RequestRecord[] = [];
  const gets = new Map<string, unknown>([
    ["/user", { id: publisherId }],
    [basePath, structuredClone(remoteRepository)],
    [`${basePath}/pulls/3`, structuredClone(remotePull)],
    [
      `${basePath}/pulls/3/files?per_page=100&page=1`,
      [
        {
          filename: "src/jobs/can-retry.ts",
          patch:
            '@@ -1,3 +1,3 @@\n export function canRetry(status: string): boolean {\n-  return status === "failed";\n+  return status !== "running";\n }\n',
        },
      ],
    ],
    [`${basePath}/issues/5`, structuredClone(remoteIssue)],
    [
      `${basePath}/issues/9`,
      { id: 709, number: 9, state: "open", title: "Original synthetic issue" },
    ],
    [
      `${basePath}/contents/src/jobs/can-retry.ts?ref=${headSha}`,
      { type: "file", encoding: "base64", content: Buffer.from(sourceText).toString("base64") },
    ],
    [`${basePath}/commits/feature%2Fretry`, { sha: headSha }],
    [
      `${basePath}/branches/feature%2Fverified`,
      { name: "feature/verified", commit: { sha: branchSha } },
    ],
    [`${basePath}/branches/main`, { name: "main", commit: { sha: baseSha } }],
    [`${basePath}/pulls/3/reviews?per_page=100&page=1`, []],
    [`${basePath}/issues/5/comments?per_page=100&page=1`, []],
    [`${basePath}/pulls?state=all&per_page=100&page=1`, []],
  ]);
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    expect(url.origin).toBe("https://api.github.com");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer synthetic-test-token");
    const record: RequestRecord = {
      method: init.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body: init.body === undefined ? null : (JSON.parse(String(init.body)) as Json),
      init,
    };
    requests.push(record);
    if (record.method === "GET") {
      if (
        record.path === `${basePath}/pulls/3/reviews/501/comments?per_page=100&page=1` &&
        !gets.has(record.path)
      ) {
        const review = requests.find(
          (request) => request.method === "POST" && request.path.endsWith("/reviews"),
        );
        const comments = (review?.body?.comments ?? []) as Json[];
        return jsonResponse(
          comments.map((comment, index) => ({
            ...comment,
            id: 800 + index,
            user: { id: publisherId },
            commit_id: headSha,
          })),
        );
      }
      if (!gets.has(record.path)) throw new Error(`Unexpected mocked GET ${record.path}`);
      const response = gets.get(record.path);
      return response instanceof Response ? response : jsonResponse(response);
    }
    if (options.mutate) return options.mutate(record);
    if (record.path.endsWith("/reviews")) {
      const state =
        record.body?.event === "APPROVE"
          ? "APPROVED"
          : record.body?.event === "REQUEST_CHANGES"
            ? "CHANGES_REQUESTED"
            : "COMMENTED";
      return jsonResponse(
        {
          id: 501,
          state,
          commit_id: record.body?.commit_id,
          body: record.body?.body,
          user: { id: publisherId },
        },
        201,
      );
    }
    if (record.path.endsWith("/comments"))
      return jsonResponse({ id: 502, body: record.body?.body, user: { id: publisherId } }, 201);
    if (record.path.endsWith("/merge")) return jsonResponse({ merged: true, sha: mergedSha });
    if (record.path.endsWith("/dispatches")) return jsonResponse({ workflow_run_id: 503 });
    if (record.method === "PATCH")
      return jsonResponse({
        id: record.path.includes("/issues/") ? 702 : 701,
        number: record.path.includes("/issues/") ? 5 : 3,
        state: "closed",
        state_reason: record.body?.state_reason,
      });
    if (record.path === `${basePath}/pulls`)
      return jsonResponse(
        {
          id: 504,
          number: 10,
          state: "open",
          title: record.body?.title,
          body: record.body?.body,
          draft: record.body?.draft,
          user: { id: publisherId },
          head: {
            ref: "feature/verified",
            sha: branchSha,
            repo: { id: repository.githubRepositoryId },
          },
          base: { ref: "main", sha: baseSha, repo: { id: repository.githubRepositoryId } },
        },
        201,
      );
    throw new Error(`Unexpected mocked mutation ${record.method} ${record.path}`);
  });
  const transport = new InvestigationGitHubTransport({
    token: "synthetic-test-token",
    expectedGitHubUserId: publisherId,
    fetch,
    ...(options.resolveSubject ? { resolveSubject: options.resolveSubject } : {}),
  });
  return {
    transport,
    fetch,
    gets,
    requests,
    writes: () => requests.filter((request) => request.method !== "GET"),
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Live network access is forbidden in investigation transport tests.");
    }),
  );
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("investigation GitHub target identity", () => {
  it("reads the exact numeric repository and current PR base/head revision through injected fetch", async () => {
    const { transport, requests } = harness();
    await expect(transport.readTarget(repository, workItem(), actor)).resolves.toEqual({
      kind: "pull_request",
      state: "open",
      headSha,
      revisionKey: hash(`${baseSha}\0${headSha}`),
    });
    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ["GET", "/user"],
      ["GET", basePath],
      ["GET", `${basePath}/pulls/3`],
    ]);
  });

  it("binds Issue actions to the immutable title/body/state/update snapshot", async () => {
    const { transport } = harness();
    const item = workItem("issue");
    await expect(transport.readTarget(repository, item, actor)).resolves.toEqual({
      kind: "issue",
      state: "open",
      headSha: null,
      revisionKey: item.subject.revisionKey,
    });
  });

  it.each([
    ["publisher", "/user", { id: publisherId + 1 }],
    ["repository numeric identity", basePath, { ...remoteRepository, id: 999 }],
    ["repository name", basePath, { ...remoteRepository, full_name: "foreign/example" }],
    ["work item number", `${basePath}/pulls/3`, { ...remotePull, number: 99 }],
  ])("refuses a changed %s without a mutation", async (_label, path, value) => {
    const h = harness();
    h.gets.set(path as string, value);
    await expect(
      h.transport.execute(intent("approve"), repository, workItem(), actor),
    ).resolves.toMatchObject({ state: "failed" });
    expect(h.writes()).toEqual([]);
  });

  it.each(["actor", "repository", "work-item", "capability", "membership"])(
    "refuses forged %s scope before any network call",
    async (kind) => {
      const h = harness();
      const action = intent("approve");
      let principal = structuredClone(actor);
      if (kind === "actor") action.actorId = "another-operator";
      if (kind === "repository") action.repositoryId = "another-repository";
      if (kind === "work-item") action.workItemId = "another-work-item";
      if (kind === "capability") principal = { ...principal, actionCapabilities: [] };
      if (kind === "membership") principal = { ...principal, repositoryIds: [] };
      await expect(
        h.transport.execute(action, repository, workItem(), principal),
      ).resolves.toMatchObject({ state: "failed" });
      expect(h.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["head", "base"])(
    "does not send an approved payload after the PR %s SHA changes",
    async (side) => {
      const h = harness();
      h.gets.set(`${basePath}/pulls/3`, { ...remotePull, [side]: { sha: "f".repeat(40) } });
      await expect(
        h.transport.execute(intent("approve"), repository, workItem(), actor),
      ).resolves.toMatchObject({ state: "failed" });
      expect(h.writes()).toEqual([]);
    },
  );

  it("does not send Issue feedback after the report snapshot changes", async () => {
    const h = harness();
    const item = workItem("issue");
    h.gets.set(`${basePath}/issues/5`, { ...remoteIssue, body: "Changed report" });
    await expect(
      h.transport.execute(intent("comment", feedback(), item), repository, item, actor),
    ).resolves.toMatchObject({ state: "failed" });
    expect(h.writes()).toEqual([]);
  });

  it("refuses a payload edited after its confirmation digest was computed", async () => {
    const h = harness();
    const action = intent("approve");
    action.payload = feedback("Unconfirmed replacement body");
    await expect(h.transport.execute(action, repository, workItem(), actor)).resolves.toMatchObject(
      { state: "failed" },
    );
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("preserves GitHub's prohibition on reviewing one's own pull request", async () => {
    const h = harness();
    h.gets.set(`${basePath}/pulls/3`, { ...remotePull, user: { id: publisherId } });
    await expect(
      h.transport.execute(intent("approve"), repository, workItem(), actor),
    ).resolves.toMatchObject({ state: "failed" });
    expect(h.writes()).toEqual([]);
  });
});

describe("investigation GitHub action payloads", () => {
  it("sends a manual P1 approval as APPROVE while preserving the explicit evidence limitation", async () => {
    const h = harness();
    const body = "Manual approval with one unresolved P1. Required E2E has not run.";
    const action = intent("approve", feedback(body));
    action.reportRef = { id: "report-with-p1", version: 1, digest: "e".repeat(64) };
    await expect(h.transport.execute(action, repository, workItem(), actor)).resolves.toMatchObject(
      { state: "succeeded", externalId: "501" },
    );
    expect(h.writes()).toMatchObject([
      {
        method: "POST",
        path: `${basePath}/pulls/3/reviews`,
        body: { commit_id: headSha, event: "APPROVE", body: bodyWithMarker(action, body) },
      },
    ]);
  });

  it("sends Request changes as a review on the exact confirmed SHA", async () => {
    const h = harness();
    const action = intent("request-changes");
    await expect(h.transport.execute(action, repository, workItem(), actor)).resolves.toMatchObject(
      { state: "succeeded" },
    );
    expect(h.writes()[0]).toMatchObject({
      method: "POST",
      path: `${basePath}/pulls/3/reviews`,
      body: {
        commit_id: headSha,
        event: "REQUEST_CHANGES",
        body: bodyWithMarker(action, "Reviewed synthetic feedback."),
      },
    });
    expect(h.writes()).toHaveLength(1);
  });

  it.each(["pull_request", "issue"] as const)(
    "comments on a %s through its issue-comment endpoint",
    async (kind) => {
      const h = harness();
      const item = workItem(kind);
      const payload = {
        kind: "feedback" as const,
        body: "Selected feedback.",
        findingIds: ["finding-text"],
        drafts: [{ id: "draft-text", body: "Additional selected text.", suggestion: null }],
      };
      const action = intent("comment", payload, item);
      await expect(h.transport.execute(action, repository, item, actor)).resolves.toMatchObject({
        state: "succeeded",
        externalId: "502",
      });
      expect(h.writes()).toMatchObject([
        {
          method: "POST",
          path: `${basePath}/issues/${item.number}/comments`,
          body: { body: `Selected feedback.\n\nAdditional selected text.\n\n${marker(action)}` },
        },
      ]);
    },
  );

  it("posts an exact, multiline suggestion as a COMMENT review instead of requesting changes", async () => {
    const h = harness();
    const payload = suggestionPayload();
    const draft = payload.drafts[0];
    if (!draft?.suggestion) throw new Error("Missing synthetic suggestion.");
    draft.suggestion.endLine = 3;
    draft.suggestion.originalContentDigest = hash('  return status !== "running";\n}');
    draft.suggestion.replacement = '  return status === "failed";\n}';
    const action = intent("suggestion-comment", payload);
    await expect(h.transport.execute(action, repository, workItem(), actor)).resolves.toMatchObject(
      { state: "succeeded" },
    );
    expect(
      h.requests.some(
        (request) => request.path === `${basePath}/contents/src/jobs/can-retry.ts?ref=${headSha}`,
      ),
    ).toBe(true);
    expect(h.writes()).toMatchObject([
      {
        method: "POST",
        path: `${basePath}/pulls/3/reviews`,
        body: {
          commit_id: headSha,
          event: "COMMENT",
          body: bodyWithMarker(action, payload.body),
          comments: [
            {
              path: "src/jobs/can-retry.ts",
              start_line: 2,
              start_side: "RIGHT",
              line: 3,
              side: "RIGHT",
              body: 'Restrict retry admission to failed tasks.\n\n```suggestion\n  return status === "failed";\n}\n```',
            },
          ],
        },
      },
    ]);
  });

  it.each([
    ["start before file", { startLine: 0 }],
    ["reversed range", { startLine: 3, endLine: 2 }],
    ["range beyond file", { endLine: 99 }],
    ["original content digest", { originalContentDigest: "f".repeat(64) }],
    ["head SHA", { headSha: "f".repeat(40) }],
    ["subject", { subjectRef: "local-patch-subject" }],
    ["path traversal", { path: "../secrets.txt" }],
    ["embedded suggestion fence", { replacement: "```\nUnreviewed markdown" }],
  ] satisfies Array<[string, Partial<InvestigationCodeSuggestion>]>)(
    "rejects invalid suggestion %s without writing",
    async (_label, changes) => {
      const h = harness();
      const payload = suggestionPayload();
      const draft = payload.drafts[0];
      if (!draft?.suggestion) throw new Error("Missing synthetic suggestion.");
      Object.assign(draft.suggestion, changes);
      await expect(
        h.transport.execute(intent("suggestion-comment", payload), repository, workItem(), actor),
      ).resolves.toMatchObject({ state: "failed" });
      expect(h.writes()).toEqual([]);
    },
  );

  it("rejects overlapping suggestions before posting a review", async () => {
    const h = harness();
    const payload = suggestionPayload();
    const draft = payload.drafts[0];
    if (!draft) throw new Error("Missing synthetic draft.");
    payload.drafts.push({ ...structuredClone(draft), id: "draft-overlap" });
    await expect(
      h.transport.execute(intent("suggestion-comment", payload), repository, workItem(), actor),
    ).resolves.toMatchObject({ state: "failed" });
    expect(h.writes()).toEqual([]);
  });

  it("rejects a suggestion for an unchanged file even when its source content matches", async () => {
    const h = harness();
    h.gets.set(`${basePath}/pulls/3/files?per_page=100&page=1`, [
      {
        filename: "src/jobs/unrelated.ts",
        patch: "@@ -1 +1 @@\n-before\n+after\n",
      },
    ]);
    await expect(
      h.transport.execute(
        intent("suggestion-comment", suggestionPayload()),
        repository,
        workItem(),
        actor,
      ),
    ).resolves.toMatchObject({ state: "failed" });
    expect(h.writes()).toEqual([]);
  });

  it("rejects a changed file without a commentable patch instead of treating it as valid", async () => {
    const h = harness();
    h.gets.set(`${basePath}/pulls/3/files?per_page=100&page=1`, [
      {
        filename: "src/jobs/can-retry.ts",
        status: "modified",
      },
    ]);
    await expect(
      h.transport.execute(
        intent("suggestion-comment", suggestionPayload()),
        repository,
        workItem(),
        actor,
      ),
    ).resolves.toMatchObject({ state: "failed" });
    expect(h.writes()).toEqual([]);
  });

  it("requires the complete replacement range to fit one diff hunk", async () => {
    const h = harness();
    h.gets.set(`${basePath}/pulls/3/files?per_page=100&page=1`, [
      {
        filename: "src/jobs/can-retry.ts",
        patch:
          "@@ -1 +1 @@\n-export function canRetry(status: string) {\n+export function canRetry(status: string): boolean {\n@@ -3 +3 @@\n-};\n+}\n",
      },
    ]);
    const payload = suggestionPayload();
    const suggestion = payload.drafts[0]?.suggestion;
    if (!suggestion) throw new Error("Missing synthetic suggestion.");
    suggestion.startLine = 1;
    suggestion.endLine = 3;
    suggestion.originalContentDigest = hash(sourceText.trimEnd());
    suggestion.replacement = sourceText
      .replace('status !== "running"', 'status === "failed"')
      .trimEnd();
    await expect(
      h.transport.execute(intent("suggestion-comment", payload), repository, workItem(), actor),
    ).resolves.toMatchObject({ state: "failed" });
    expect(h.writes()).toEqual([]);
  });

  it("refuses oversized explicit feedback rather than silently dropping selected text", async () => {
    const h = harness();
    await expect(
      h.transport.execute(
        intent("comment", feedback("x".repeat(60_001))),
        repository,
        workItem(),
        actor,
      ),
    ).resolves.toMatchObject({ state: "failed" });
    expect(h.writes()).toEqual([]);
  });

  it.each(["pull_request", "issue"] as const)("closes a %s with one PATCH", async (kind) => {
    const h = harness();
    const item = workItem(kind);
    await expect(
      h.transport.execute(
        intent("close", { kind: "close", reason: "completed", duplicateNumber: null }, item),
        repository,
        item,
        actor,
      ),
    ).resolves.toMatchObject({ state: "succeeded" });
    expect(h.writes()).toMatchObject([
      {
        method: "PATCH",
        path: `${basePath}/${kind === "issue" ? "issues" : "pulls"}/${item.number}`,
        body:
          kind === "issue" ? { state: "closed", state_reason: "completed" } : { state: "closed" },
      },
    ]);
  });

  it("closes a duplicate with one atomic Issue PATCH using its numeric duplicate ID", async () => {
    const h = harness();
    const item = workItem("issue");
    const action = intent(
      "close-as-duplicate",
      { kind: "close", reason: "duplicate", duplicateNumber: 9 },
      item,
    );
    await expect(h.transport.execute(action, repository, item, actor)).resolves.toMatchObject({
      state: "succeeded",
    });
    expect(
      h.requests.some(
        (request) => request.method === "GET" && request.path === `${basePath}/issues/9`,
      ),
    ).toBe(true);
    expect(h.writes()).toMatchObject([
      {
        method: "PATCH",
        path: `${basePath}/issues/5`,
        body: { state: "closed", state_reason: "duplicate", duplicate_issue_id: 709 },
      },
    ]);
  });

  it.each(["same-issue", "pull-request"])(
    "rejects an invalid %s duplicate target without writing",
    async (kind) => {
      const h = harness();
      const item = workItem("issue");
      if (kind === "pull-request")
        h.gets.set(`${basePath}/issues/9`, { id: 709, number: 9, pull_request: {} });
      const action = intent(
        "close-as-duplicate",
        { kind: "close", reason: "duplicate", duplicateNumber: kind === "same-issue" ? 5 : 9 },
        item,
      );
      await expect(h.transport.execute(action, repository, item, actor)).resolves.toMatchObject({
        state: "failed",
      });
      expect(h.writes()).toEqual([]);
    },
  );

  it("merges with the explicitly selected method and optimistic head SHA", async () => {
    const h = harness();
    const action = intent("merge", {
      kind: "merge",
      method: "squash",
      commitTitle: "Selected commit title",
    });
    await expect(h.transport.execute(action, repository, workItem(), actor)).resolves.toMatchObject(
      { state: "succeeded", externalId: mergedSha },
    );
    expect(h.writes()).toMatchObject([
      {
        method: "PUT",
        path: `${basePath}/pulls/3/merge`,
        body: { sha: headSha, merge_method: "squash", commit_title: "Selected commit title" },
      },
    ]);
  });

  it("dispatches the checked workflow ref once and requests the run details", async () => {
    const h = harness();
    const action = intent("trigger-ci", {
      kind: "trigger-ci",
      workflowId: "ci.yml",
      ref: "feature/retry",
      inputs: { suite: "required" },
    });
    await expect(h.transport.execute(action, repository, workItem(), actor)).resolves.toMatchObject(
      { state: "succeeded", externalId: "503" },
    );
    expect(
      h.requests.some((request) => request.path === `${basePath}/commits/feature%2Fretry`),
    ).toBe(true);
    expect(h.writes()).toMatchObject([
      {
        method: "POST",
        path: `${basePath}/actions/workflows/ci.yml/dispatches`,
        body: { ref: "feature/retry", inputs: { suite: "required" }, return_run_details: true },
      },
    ]);
  });

  it("does not dispatch a workflow when its ref resolves to a different commit", async () => {
    const h = harness();
    h.gets.set(`${basePath}/commits/feature%2Fretry`, { sha: "f".repeat(40) });
    const action = intent("trigger-ci", {
      kind: "trigger-ci",
      workflowId: "ci.yml",
      ref: "feature/retry",
      inputs: {},
    });
    await expect(h.transport.execute(action, repository, workItem(), actor)).resolves.toMatchObject(
      { state: "failed" },
    );
    expect(h.writes()).toEqual([]);
  });
});

describe("investigation create-PR branch ownership", () => {
  function createIntent(item: InvestigationWorkItemRecord): InvestigationActionIntentV1 {
    const action = intent(
      "create-pr",
      {
        kind: "create-pr",
        branchSubjectRef: "subject-remote-branch",
        title: "Implement reviewed repair",
        body: "Prepared repair description.",
        baseBranch: "main",
        draft: true,
      },
      item,
    );
    action.subjectRef = "subject-remote-branch";
    return action;
  }

  it("requires an existing registered remote branch and does not implicitly commit or push", async () => {
    const item = workItem("issue");
    const subject = branchSubject(item);
    const resolveSubject = vi.fn(async () => subject);
    const h = harness({ resolveSubject });
    const action = createIntent(item);
    await expect(h.transport.execute(action, repository, item, actor)).resolves.toMatchObject({
      state: "succeeded",
      externalId: "504",
    });
    expect(resolveSubject).toHaveBeenCalledWith(subject.id, repository.id, item.id);
    expect(
      h.requests.some(
        (request) =>
          request.method === "GET" && request.path === `${basePath}/branches/feature%2Fverified`,
      ),
    ).toBe(true);
    expect(h.writes()).toMatchObject([
      {
        method: "POST",
        path: `${basePath}/pulls`,
        body: {
          head: "feature/verified",
          base: "main",
          title: "Implement reviewed repair",
          body: bodyWithMarker(action, "Prepared repair description."),
          draft: true,
        },
      },
    ]);
  });

  it.each([
    "missing",
    "local-patch",
    "foreign-repository",
    "foreign-work-item",
    "different-subject",
  ])("does not create a PR from a %s source", async (kind) => {
    const item = workItem("issue");
    const subject = branchSubject(item);
    let resolved: InvestigationSubjectV1 | null = subject;
    if (kind === "missing") resolved = null;
    if (kind === "local-patch")
      resolved = {
        id: subject.id,
        kind: "local_patch",
        repositoryId: repository.id,
        workItemId: item.id,
        revisionKey: subject.revisionKey,
        baseSubjectRef: item.subject.id,
        baseSha,
        patchDigest: "f".repeat(64),
        artifactRef: "local-patch",
      };
    if (kind === "foreign-repository")
      resolved = { ...subject, repositoryId: "foreign-repository" };
    if (kind === "foreign-work-item") resolved = { ...subject, workItemId: "foreign-work-item" };
    if (kind === "different-subject") resolved = { ...subject, id: "different-branch-subject" };
    const h = harness({ resolveSubject: async () => resolved });
    await expect(
      h.transport.execute(createIntent(item), repository, item, actor),
    ).resolves.toMatchObject({ state: "failed" });
    expect(h.writes()).toEqual([]);
  });

  it.each(["head", "base", "missing-branch"])(
    "does not create a PR after the verified %s branch changes",
    async (kind) => {
      const item = workItem("issue");
      const h = harness({ resolveSubject: async () => branchSubject(item) });
      if (kind === "missing-branch")
        h.gets.set(
          `${basePath}/branches/feature%2Fverified`,
          jsonResponse({ message: "Not Found" }, 404),
        );
      else
        h.gets.set(`${basePath}/branches/${kind === "base" ? "main" : "feature%2Fverified"}`, {
          commit: { sha: "f".repeat(40) },
        });
      await expect(
        h.transport.execute(createIntent(item), repository, item, actor),
      ).resolves.toMatchObject({ state: "failed" });
      expect(h.writes()).toEqual([]);
    },
  );
});

describe("investigation ambiguous GitHub delivery", () => {
  it("never resubmits an intent already marked unknown", async () => {
    const h = harness();
    const action = intent("approve");
    action.state = "unknown";
    await expect(h.transport.execute(action, repository, workItem(), actor)).resolves.toMatchObject(
      { state: "failed" },
    );
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("reconciles a lost approval response using the exact actor, SHA, body, and event with GETs only", async () => {
    const h = harness({
      mutate: async () => {
        throw new Error("Synthetic connection reset after send.");
      },
    });
    const action = intent("approve");
    await expect(h.transport.execute(action, repository, workItem(), actor)).resolves.toMatchObject(
      { state: "unknown" },
    );
    expect(h.writes()).toHaveLength(1);
    h.gets.set(`${basePath}/pulls/3/reviews?per_page=100&page=1`, [
      {
        id: 501,
        user: { id: publisherId },
        commit_id: headSha,
        state: "APPROVED",
        body: bodyWithMarker(action, "Reviewed synthetic feedback."),
      },
    ]);
    action.state = "unknown";
    await expect(
      h.transport.reconcile(action, repository, workItem(), actor),
    ).resolves.toMatchObject({ state: "succeeded", externalId: "501" });
    expect(h.writes()).toHaveLength(1);
  });

  it.each(["missing", "wrong-actor", "wrong-sha", "wrong-body", "wrong-event", "duplicate"])(
    "keeps a %s approval receipt unknown without a resend",
    async (kind) => {
      const h = harness();
      const action = intent("approve");
      action.state = "unknown";
      const receipt: Json = {
        id: 501,
        user: { id: publisherId },
        commit_id: headSha,
        state: "APPROVED",
        body: bodyWithMarker(action, "Reviewed synthetic feedback."),
      };
      if (kind === "wrong-actor") receipt.user = { id: 999 };
      if (kind === "wrong-sha") receipt.commit_id = "f".repeat(40);
      if (kind === "wrong-body") receipt.body = `Different text\n\n${marker(action)}`;
      if (kind === "wrong-event") receipt.state = "COMMENTED";
      h.gets.set(
        `${basePath}/pulls/3/reviews?per_page=100&page=1`,
        kind === "missing"
          ? []
          : kind === "duplicate"
            ? [receipt, { ...receipt, id: 502 }]
            : [receipt],
      );
      await expect(
        h.transport.reconcile(action, repository, workItem(), actor),
      ).resolves.toMatchObject({ state: "unknown" });
      expect(h.writes()).toEqual([]);
    },
  );

  it("does not reconcile a suggestion review whose actual replacement comments differ", async () => {
    const h = harness();
    const action = intent("suggestion-comment", suggestionPayload());
    action.state = "unknown";
    h.gets.set(`${basePath}/pulls/3/reviews?per_page=100&page=1`, [
      {
        id: 501,
        user: { id: publisherId },
        commit_id: headSha,
        state: "COMMENTED",
        body: bodyWithMarker(action, "Review the selected replacement."),
      },
    ]);
    h.gets.set(`${basePath}/pulls/3/reviews/501/comments?per_page=100&page=1`, [
      {
        id: 801,
        path: "src/jobs/can-retry.ts",
        line: 2,
        side: "RIGHT",
        body: "A different replacement.",
      },
    ]);
    await expect(
      h.transport.reconcile(action, repository, workItem(), actor),
    ).resolves.toMatchObject({ state: "unknown" });
    expect(h.writes()).toEqual([]);
  });

  it.each(["close", "close-as-duplicate", "trigger-ci"] as const)(
    "does not repeat ambiguous %s delivery",
    async (actionKind) => {
      const item = actionKind === "trigger-ci" ? workItem() : workItem("issue");
      const payload: InvestigationActionPayload =
        actionKind === "trigger-ci"
          ? { kind: "trigger-ci", workflowId: "ci.yml", ref: "feature/retry", inputs: {} }
          : {
              kind: "close",
              reason: actionKind === "close" ? "completed" : "duplicate",
              duplicateNumber: actionKind === "close" ? null : 9,
            };
      const action = intent(actionKind, payload, item);
      action.state = "unknown";
      const h = harness();
      await expect(h.transport.reconcile(action, repository, item, actor)).resolves.toMatchObject({
        state: "unknown",
      });
      expect(h.writes()).toEqual([]);
    },
  );

  it("treats malformed successful review receipts as unknown rather than a reason to retry", async () => {
    const h = harness({
      mutate: () =>
        jsonResponse(
          {
            id: 501,
            state: "APPROVED",
            body: "wrong",
            commit_id: headSha,
            user: { id: publisherId },
          },
          201,
        ),
    });
    await expect(
      h.transport.execute(intent("approve"), repository, workItem(), actor),
    ).resolves.toMatchObject({ state: "unknown" });
    expect(h.writes()).toHaveLength(1);
  });

  it.each([403, 422, 503, 408])(
    "makes only one mutation attempt for an HTTP %s response",
    async (status) => {
      const h = harness({ mutate: () => jsonResponse({ message: "Synthetic rejection" }, status) });
      await expect(
        h.transport.execute(intent("approve"), repository, workItem(), actor),
      ).resolves.toMatchObject({ state: status === 403 || status === 422 ? "failed" : "unknown" });
      expect(h.writes()).toHaveLength(1);
    },
  );
});
