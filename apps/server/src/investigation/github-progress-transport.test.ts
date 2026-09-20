import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationGitHubTransport } from "./github-transport.js";
import type {
  InvestigationCommentTarget,
  InvestigationOperatorPrincipal,
  InvestigationProgressCommentRequest,
  InvestigationRepositoryRecord,
  InvestigationWorkItemRecord,
} from "./types.js";

type Json = Record<string, unknown>;
type RequestRecord = { method: string; path: string; body: Json | null };

const publisherId = 42;
const publisherLogin = "fixture-publisher";
const basePath = "/repos/fixture/progress";
const timestamp = "2026-09-18T08:00:00.000Z";
const marker = "<!-- agentic-review-progress:task-fixture -->";
const receivedBody = `Investigation received.\n\n${marker}`;
const runningBody = `Investigation started.\n\n${marker}`;
const repository: InvestigationRepositoryRecord = {
  id: "repo-fixture",
  fullName: "fixture/progress",
  githubRepositoryId: 700,
};
const actor: InvestigationOperatorPrincipal = {
  id: "operator-fixture",
  displayName: "Synthetic operator",
  repositoryIds: [repository.id],
  permissions: ["action:execute"],
  actionCapabilities: ["comment"],
  allowRepositoryExecution: false,
  githubIdentity: { githubUserId: publisherId, githubLogin: publisherLogin },
};

function workItem(kind: "pull_request" | "issue" = "issue"): InvestigationWorkItemRecord {
  return {
    id: "item-fixture",
    repositoryId: repository.id,
    kind,
    number: 7,
    title: "Synthetic work item",
    body: "Synthetic report",
    state: "open",
    updatedAt: timestamp,
    subject:
      kind === "issue"
        ? {
            id: "subject-fixture",
            kind: "issue_snapshot",
            repositoryId: repository.id,
            workItemId: "item-fixture",
            revisionKey: "a".repeat(64),
            snapshotDigest: "b".repeat(64),
          }
        : {
            id: "subject-fixture",
            kind: "original_pr",
            repositoryId: repository.id,
            workItemId: "item-fixture",
            revisionKey: "a".repeat(64),
            baseSha: "b".repeat(40),
            headSha: "c".repeat(40),
          },
  };
}

function createRequest(): InvestigationProgressCommentRequest {
  return { marker, body: receivedBody, externalId: null, previousBody: null };
}

function updateRequest(): InvestigationProgressCommentRequest {
  return { marker, body: runningBody, externalId: "810", previousBody: receivedBody };
}

function comment(body = receivedBody, id = 810): Json {
  return {
    id,
    body,
    user: { id: publisherId, login: publisherLogin },
    issue_url: `https://api.github.com${basePath}/issues/7`,
  };
}

function response(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function harness(
  options: {
    onRead?: (request: RequestRecord) => void;
    mutate?: (request: RequestRecord) => Response | Promise<Response>;
  } = {},
) {
  const requests: RequestRecord[] = [];
  const gets = new Map<string, unknown>([
    ["/user", { id: publisherId, login: publisherLogin }],
    [
      basePath,
      {
        id: repository.githubRepositoryId,
        full_name: repository.fullName,
        permissions: { push: true, maintain: false, admin: false, triage: true },
      },
    ],
    [
      `${basePath}/issues/7`,
      { id: 701, number: 7, state: "open", locked: false, user: { id: 99 } },
    ],
    [`${basePath}/pulls/7`, { id: 701, number: 7, state: "open", locked: false, user: { id: 99 } }],
    [`${basePath}/issues/comments/810`, comment()],
    [`${basePath}/issues/7/comments?per_page=100&page=1`, []],
  ]);
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    expect(url.origin).toBe("https://api.github.com");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer synthetic-token");
    const request = {
      method: init.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body: typeof init.body === "string" ? (JSON.parse(init.body) as Json) : null,
    };
    requests.push(request);
    if (request.method === "GET") {
      options.onRead?.(request);
      const value = gets.get(request.path);
      return value instanceof Response
        ? value
        : value === undefined
          ? response({ message: "Not found" }, 404)
          : response(value);
    }
    if (options.mutate) return options.mutate(request);
    return response(comment(String(request.body?.body)), request.method === "POST" ? 201 : 200);
  });
  const transport = new InvestigationGitHubTransport({
    token: "synthetic-token",
    expectedGitHubUserId: publisherId,
    fetch,
  });
  return {
    transport,
    requests,
    gets,
    mutations: () => requests.filter((request) => request.method !== "GET"),
  };
}

describe("investigation progress comment transport", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["pull_request", "issue"] as const)(
    "creates one conversation comment for a %s",
    async (kind) => {
      const fixture = harness();
      const result = await fixture.transport.publishProgressComment(
        createRequest(),
        repository,
        workItem(kind),
        actor,
      );
      expect(result).toMatchObject({
        state: "succeeded",
        effect: "applied",
        retryable: false,
        reasonCode: "comment_created",
        externalId: "810",
      });
      expect(fixture.mutations()).toEqual([
        {
          method: "POST",
          path: `${basePath}/issues/7/comments`,
          body: { body: receivedBody },
        },
      ]);
    },
  );

  it("updates the exact owned comment only after verifying its previous body", async () => {
    const fixture = harness();
    const result = await fixture.transport.publishProgressComment(
      updateRequest(),
      repository,
      workItem(),
      actor,
    );
    expect(result).toMatchObject({
      state: "succeeded",
      effect: "applied",
      retryable: false,
      reasonCode: "comment_updated",
      externalId: "810",
    });
    expect(fixture.requests[0]).toMatchObject({
      method: "GET",
      path: `${basePath}/issues/comments/810`,
    });
    expect(fixture.mutations()).toEqual([
      {
        method: "PATCH",
        path: `${basePath}/issues/comments/810`,
        body: { body: runningBody },
      },
    ]);
  });

  it("updates an adopted automatic result comment using its exact legacy action marker", async () => {
    const fixture = harness();
    const legacyMarker = `<!-- agentic-review-action:legacy-intent:${"a".repeat(64)} -->`;
    const previousBody = `Retained result.\n\n${legacyMarker}`;
    const body = `Current result.\n\n${legacyMarker}`;
    fixture.gets.set(`${basePath}/issues/comments/810`, comment(previousBody));
    const result = await fixture.transport.publishProgressComment(
      { marker: legacyMarker, body, externalId: "810", previousBody },
      repository,
      workItem(),
      actor,
    );
    expect(result).toMatchObject({ state: "succeeded", externalId: "810" });
    expect(fixture.mutations()).toEqual([
      { method: "PATCH", path: `${basePath}/issues/comments/810`, body: { body } },
    ]);
  });

  it("does not create a new comment using a retained action marker", async () => {
    const fixture = harness();
    const legacyMarker = `<!-- agentic-review-action:legacy-intent:${"a".repeat(64)} -->`;
    const result = await fixture.transport.publishProgressComment(
      {
        marker: legacyMarker,
        body: `Current result.\n\n${legacyMarker}`,
        externalId: null,
        previousBody: null,
      },
      repository,
      workItem(),
      actor,
    );
    expect(result).toMatchObject({ state: "failed", effect: "not_sent" });
    expect(fixture.mutations()).toEqual([]);
  });

  it("rejects a foreign managed marker in an adopted result comment", async () => {
    const fixture = harness();
    const legacyMarker = `<!-- agentic-review-action:legacy-intent:${"a".repeat(64)} -->`;
    const previousBody = `Retained result.\n\n${legacyMarker}`;
    const result = await fixture.transport.publishProgressComment(
      {
        marker: legacyMarker,
        body: `Current result.\n\n${legacyMarker}\n\n${marker}`,
        externalId: "810",
        previousBody,
      },
      repository,
      workItem(),
      actor,
    );
    expect(result).toMatchObject({ state: "failed", effect: "not_sent" });
    expect(fixture.mutations()).toEqual([]);
  });

  it("recognizes an already applied update without invoking dispatch", async () => {
    const fixture = harness();
    fixture.gets.set(`${basePath}/issues/comments/810`, comment(runningBody));
    const beforeDispatch = vi.fn();
    expect(
      await fixture.transport.publishProgressComment(
        updateRequest(),
        repository,
        workItem(),
        actor,
        beforeDispatch,
      ),
    ).toMatchObject({
      state: "succeeded",
      effect: "applied",
      retryable: false,
      reasonCode: "comment_already_applied",
      externalId: "810",
    });
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(fixture.mutations()).toHaveLength(0);
  });

  it("accepts canonical repository casing in the exact issue comment URL", async () => {
    const fixture = harness({
      mutate: (request) =>
        response({
          ...comment(String(request.body?.body)),
          issue_url: "https://api.github.com/repos/Fixture/Progress/issues/7",
        }),
    });
    fixture.gets.set(`${basePath}/issues/comments/810`, {
      ...comment(),
      issue_url: "https://api.github.com/repos/Fixture/Progress/issues/7",
    });
    expect(
      await fixture.transport.publishProgressComment(
        updateRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({ state: "succeeded", externalId: "810" });
    expect(fixture.mutations()).toHaveLength(1);
  });

  it("runs the dispatch fence synchronously after all preflight reads", async () => {
    const fixture = harness();
    let dispatchRequestCount = 0;
    const beforeDispatch = vi.fn(() => {
      dispatchRequestCount = fixture.requests.length;
      expect(fixture.requests.at(-1)?.path).toBe(`${basePath}/issues/7`);
      expect(fixture.mutations()).toHaveLength(0);
    });
    await fixture.transport.publishProgressComment(
      updateRequest(),
      repository,
      workItem(),
      actor,
      beforeDispatch,
    );
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(fixture.requests[dispatchRequestCount]?.method).toBe("PATCH");
    expect(fixture.requests).toHaveLength(dispatchRequestCount + 1);
  });

  it("does not mutate when the final dispatch fence rejects the operation", async () => {
    const fixture = harness();
    const result = await fixture.transport.publishProgressComment(
      createRequest(),
      repository,
      workItem(),
      actor,
      () => {
        throw new Error("Dispatch authorization was revoked.");
      },
    );
    expect(result.state).toBe("failed");
    expect(fixture.mutations()).toHaveLength(0);
  });

  it("freezes the selected body before asynchronous preflight", async () => {
    const request = { ...updateRequest() };
    const fixture = harness({
      onRead: () => {
        request.body = `A different body.\n\n${marker}`;
        request.externalId = "999";
      },
    });
    expect(
      await fixture.transport.publishProgressComment(request, repository, workItem(), actor),
    ).toMatchObject({ state: "succeeded", externalId: "810" });
    expect(fixture.mutations()[0]).toMatchObject({
      path: `${basePath}/issues/comments/810`,
      body: { body: runningBody },
    });
  });

  it("uses one frozen repository and target identity throughout preflight and dispatch", async () => {
    const repositoryInput = { ...repository };
    const targetInput = { ...workItem(), githubWorkItemId: 701 };
    const fixture = harness({
      onRead: () => {
        repositoryInput.fullName = "other/repository";
        repositoryInput.githubRepositoryId = 999;
        targetInput.number = 8;
        targetInput.githubWorkItemId = 702;
      },
    });
    expect(
      await fixture.transport.publishProgressComment(
        createRequest(),
        repositoryInput,
        targetInput,
        actor,
      ),
    ).toMatchObject({ state: "succeeded", effect: "applied" });
    expect(fixture.requests.map(({ path }) => path)).toEqual([
      "/user",
      basePath,
      `${basePath}/issues/7`,
      `${basePath}/issues/7/comments`,
    ]);
  });

  it.each([
    ["different owner", { user: { id: 99 } }],
    ["different target", { issue_url: `https://api.github.com${basePath}/issues/8` }],
    ["different repository", { issue_url: "https://api.github.com/repos/other/repo/issues/7" }],
    ["different host", { issue_url: "https://untrusted.example/repos/fixture/progress/issues/7" }],
    ["different ID", { id: 811 }],
    ["edited body", { body: `An external edit.\n\n${marker}` }],
    ["missing marker", { body: "An external edit." }],
    ["duplicate marker", { body: `${receivedBody}\n${marker}` }],
  ] as const)("refuses to overwrite a comment with %s", async (_name, changed) => {
    const fixture = harness();
    fixture.gets.set(`${basePath}/issues/comments/810`, { ...comment(), ...(changed as Json) });
    const result = await fixture.transport.publishProgressComment(
      updateRequest(),
      repository,
      workItem(),
      actor,
    );
    expect(result).toMatchObject({ state: "failed", externalId: "810" });
    expect(fixture.mutations()).toHaveLength(0);
  });

  it("does not recreate a deleted comment", async () => {
    const fixture = harness();
    fixture.gets.delete(`${basePath}/issues/comments/810`);
    expect(
      await fixture.transport.publishProgressComment(
        updateRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({ state: "failed", externalId: "810" });
    expect(fixture.mutations()).toHaveLength(0);
  });

  it.each([
    ["untrusted marker", { marker: "<!-- external-marker -->" }],
    ["injected marker", { marker: "<!-- agentic-review-progress:task -->injected" }],
    ["missing marker", { body: "Missing marker" }],
    ["duplicate marker", { body: `${receivedBody}\n${marker}` }],
    ["second task marker", { body: `${receivedBody}\n<!-- agentic-review-progress:other -->` }],
    ["oversize UTF-8 body", { body: `${"\u754c".repeat(20_000)}\n${marker}` }],
    ["create with previous body", { previousBody: receivedBody }],
    ["update without previous body", { externalId: "810" }],
    ["URL as comment ID", { externalId: "https://untrusted.example", previousBody: receivedBody }],
    ["unsafe numeric ID", { externalId: "9007199254740992", previousBody: receivedBody }],
  ] as const)("rejects %s before contacting GitHub", async (_name, changed) => {
    const fixture = harness();
    const result = await fixture.transport.publishProgressComment(
      { ...createRequest(), ...changed },
      repository,
      workItem(),
      actor,
    );
    expect(result.state).toBe("failed");
    expect(fixture.requests).toHaveLength(0);
  });

  it.each([
    ["publisher", "/user", { id: 999, login: publisherLogin }],
    ["publisher login", "/user", { id: publisherId, login: "different-publisher" }],
    ["repository", basePath, { id: 999, full_name: repository.fullName }],
    ["target", `${basePath}/issues/7`, { id: 701, number: 8 }],
  ] as const)("rejects a changed %s during preflight", async (_name, path, changed) => {
    const fixture = harness();
    fixture.gets.set(String(path), changed);
    expect(
      await fixture.transport.publishProgressComment(
        createRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({ state: "failed" });
    expect(fixture.mutations()).toHaveLength(0);
  });

  it("checks actor comment authority again after asynchronous preflight", async () => {
    const capabilities: Array<"comment"> = ["comment"];
    const fixture = harness({
      onRead: (request) => {
        if (request.path === `${basePath}/issues/7`) capabilities.length = 0;
      },
    });
    expect(
      await fixture.transport.publishProgressComment(createRequest(), repository, workItem(), {
        ...actor,
        actionCapabilities: capabilities,
      }),
    ).toMatchObject({ state: "failed" });
    expect(fixture.mutations()).toHaveLength(0);
  });

  it("rechecks publisher identity after reading the owned update target", async () => {
    const fixture = harness({
      onRead: (request) => {
        if (request.path === `${basePath}/issues/comments/810`)
          fixture.gets.set("/user", { id: 999, login: publisherLogin });
      },
    });
    expect(
      await fixture.transport.publishProgressComment(
        updateRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({ state: "failed" });
    expect(fixture.mutations()).toHaveLength(0);
  });

  it("refuses a conversation whose required remote authority was revoked", async () => {
    const fixture = harness();
    fixture.gets.set(basePath, {
      id: repository.githubRepositoryId,
      full_name: repository.fullName,
      permissions: { push: false, maintain: false, admin: false, triage: false },
    });
    fixture.gets.set(`${basePath}/issues/7`, {
      id: 701,
      number: 7,
      state: "open",
      locked: true,
      user: { id: 99 },
    });
    expect(
      await fixture.transport.publishProgressComment(
        updateRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({ state: "failed" });
    expect(fixture.mutations()).toHaveLength(0);
  });

  it("can update progress after the target is closed", async () => {
    const fixture = harness();
    fixture.gets.set(`${basePath}/issues/7`, {
      id: 701,
      number: 7,
      state: "closed",
      locked: false,
      user: { id: 99 },
    });
    expect(
      await fixture.transport.publishProgressComment(
        updateRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({ state: "succeeded" });
    expect(fixture.mutations()).toHaveLength(1);
  });

  it.each(["create", "update"] as const)(
    "reconciles an uncertain %s with GETs only",
    async (kind) => {
      const request = kind === "create" ? createRequest() : updateRequest();
      const fixture = harness({
        mutate: () => {
          const receipt = comment(request.body);
          fixture.gets.set(`${basePath}/issues/comments/810`, receipt);
          fixture.gets.set(`${basePath}/issues/7/comments?per_page=100&page=1`, [receipt]);
          throw new Error("The response connection was lost after GitHub accepted the request.");
        },
      });
      expect(
        await fixture.transport.publishProgressComment(request, repository, workItem(), actor),
      ).toMatchObject({ state: "unknown", externalId: request.externalId });
      const writes = fixture.mutations().length;
      const reads = fixture.requests.length;
      expect(
        await fixture.transport.reconcileProgressComment(request, repository, workItem(), actor),
      ).toMatchObject({ state: "succeeded", externalId: "810" });
      expect(fixture.mutations()).toHaveLength(writes);
      expect(fixture.requests.slice(reads).every((entry) => entry.method === "GET")).toBe(true);
    },
  );

  it.each(["create", "update"] as const)(
    "retains an absent uncertain %s without retrying the mutation",
    async (kind) => {
      const fixture = harness({ mutate: () => response({ message: "Unavailable" }, 503) });
      const request = kind === "create" ? createRequest() : updateRequest();
      expect(
        await fixture.transport.publishProgressComment(request, repository, workItem(), actor),
      ).toMatchObject({ state: "unknown" });
      for (let attempt = 0; attempt < 2; attempt += 1)
        expect(
          await fixture.transport.reconcileProgressComment(request, repository, workItem(), actor),
        ).toMatchObject({ state: "unknown", externalId: request.externalId });
      expect(fixture.mutations()).toHaveLength(1);
    },
  );

  it("does not reconcile a forged comment from another author", async () => {
    const fixture = harness();
    fixture.gets.set(`${basePath}/issues/7/comments?per_page=100&page=1`, [
      { ...comment(), user: { id: 99 } },
    ]);
    expect(
      await fixture.transport.reconcileProgressComment(
        createRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({ state: "unknown" });
    expect(fixture.mutations()).toHaveLength(0);
  });

  it("requires the exact target and complete frozen body during reconciliation", async () => {
    const fixture = harness();
    fixture.gets.set(`${basePath}/issues/7/comments?per_page=100&page=1`, [
      comment(`A changed body.\n\n${marker}`),
    ]);
    expect(
      await fixture.transport.reconcileProgressComment(
        createRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({ state: "unknown" });
    fixture.gets.set(`${basePath}/issues/comments/810`, {
      ...comment(runningBody),
      issue_url: `https://api.github.com${basePath}/issues/8`,
    });
    expect(
      await fixture.transport.reconcileProgressComment(
        updateRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({ state: "unknown", externalId: "810" });
    expect(fixture.mutations()).toHaveLength(0);
  });

  it("continues across pages to detect duplicate matching comments", async () => {
    const fixture = harness();
    const unrelated = Array.from({ length: 99 }, (_, index) => comment("Unrelated", index + 1));
    fixture.gets.set(`${basePath}/issues/7/comments?per_page=100&page=1`, [
      comment(),
      ...unrelated,
    ]);
    fixture.gets.set(`${basePath}/issues/7/comments?per_page=100&page=2`, [
      comment(receivedBody, 811),
    ]);
    const result = await fixture.transport.reconcileProgressComment(
      createRequest(),
      repository,
      workItem(),
      actor,
    );
    expect(result).toMatchObject({ state: "unknown", externalId: null });
    expect(result.message).toContain("Multiple matching");
    expect(fixture.mutations()).toHaveLength(0);
  });

  it("retains uncertainty if a later reconciliation page cannot be read", async () => {
    const fixture = harness();
    fixture.gets.set(`${basePath}/issues/7/comments?per_page=100&page=1`, [
      comment(),
      ...Array.from({ length: 99 }, (_, index) => comment("Unrelated", index + 1)),
    ]);
    fixture.gets.set(
      `${basePath}/issues/7/comments?per_page=100&page=2`,
      response({ message: "Unavailable" }, 503),
    );
    expect(
      await fixture.transport.reconcileProgressComment(
        createRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({ state: "unknown" });
    expect(fixture.mutations()).toHaveLength(0);
  });

  it.each(["pull_request", "issue"] as const)(
    "publishes an early assignment acknowledgement for a minimal %s target",
    async (kind) => {
      const fixture = harness();
      const target: InvestigationCommentTarget = {
        id: "accepted-assignment-fixture",
        repositoryId: repository.id,
        kind,
        number: 7,
        githubWorkItemId: 701,
      };
      fixture.gets.set(`${basePath}/${kind === "issue" ? "issues" : "pulls"}/7`, {
        id: 701,
        number: 7,
        locked: false,
        user: { id: 99 },
        assignees: [{ id: publisherId }],
      });
      const beforeDispatch = vi.fn();
      expect(
        await fixture.transport.publishProgressComment(
          { ...createRequest(), expectedAssigneeUserId: publisherId },
          repository,
          target,
          actor,
          beforeDispatch,
        ),
      ).toMatchObject({ state: "succeeded", effect: "applied", reasonCode: "comment_created" });
      expect(beforeDispatch).toHaveBeenCalledOnce();
      expect(fixture.mutations()).toHaveLength(1);
    },
  );

  it("rejects a changed numeric work item identity before an early comment", async () => {
    const fixture = harness();
    expect(
      await fixture.transport.publishProgressComment(
        createRequest(),
        repository,
        {
          id: "assignment-fixture",
          repositoryId: repository.id,
          kind: "issue",
          number: 7,
          githubWorkItemId: 702,
        },
        actor,
      ),
    ).toMatchObject({
      state: "failed",
      effect: "not_sent",
      retryable: false,
      reasonCode: "work_item_identity_changed",
    });
    expect(fixture.mutations()).toHaveLength(0);
  });

  it("refuses the first POST when the accepted assignee is no longer assigned", async () => {
    const fixture = harness();
    fixture.gets.set(`${basePath}/issues/7`, {
      id: 701,
      number: 7,
      locked: false,
      user: { id: 99 },
      assignees: [{ id: publisherId + 1 }],
    });
    const beforeDispatch = vi.fn();
    expect(
      await fixture.transport.publishProgressComment(
        { ...createRequest(), expectedAssigneeUserId: publisherId },
        repository,
        workItem(),
        actor,
        beforeDispatch,
      ),
    ).toMatchObject({
      state: "failed",
      effect: "not_sent",
      retryable: false,
      reasonCode: "assignment_not_current",
    });
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(fixture.mutations()).toHaveLength(0);
  });

  it("updates and reconciles an existing comment after the assignment is removed", async () => {
    const fixture = harness();
    const request = { ...updateRequest(), expectedAssigneeUserId: publisherId };
    expect(
      await fixture.transport.publishProgressComment(request, repository, workItem(), actor),
    ).toMatchObject({ state: "succeeded", effect: "applied" });
    fixture.gets.set(`${basePath}/issues/comments/810`, comment(runningBody));
    expect(
      await fixture.transport.reconcileProgressComment(request, repository, workItem(), actor),
    ).toMatchObject({ state: "succeeded", effect: "applied", reasonCode: "comment_reconciled" });
    fixture.gets.set(`${basePath}/issues/7/comments?per_page=100&page=1`, [comment()]);
    expect(
      await fixture.transport.reconcileProgressComment(
        { ...createRequest(), expectedAssigneeUserId: publisherId },
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({ state: "succeeded", effect: "applied", reasonCode: "comment_reconciled" });
    expect(fixture.mutations()).toHaveLength(1);
  });

  it("classifies a revoked dispatch grant as definitely not sent", async () => {
    const fixture = harness();
    expect(
      await fixture.transport.publishProgressComment(
        createRequest(),
        repository,
        workItem(),
        actor,
        () => {
          throw new Error("The local assignment grant was revoked.");
        },
      ),
    ).toMatchObject({
      state: "failed",
      effect: "not_sent",
      retryable: false,
      reasonCode: "dispatch_guard_rejected",
    });
    expect(fixture.mutations()).toHaveLength(0);
  });

  it("makes a transient preflight connection failure safe to retry", async () => {
    const fixture = harness({
      onRead: () => {
        throw new Error("Synthetic connection failure");
      },
    });
    expect(
      await fixture.transport.publishProgressComment(
        createRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({
      state: "failed",
      effect: "not_sent",
      retryable: true,
      reasonCode: "github_read_failed",
    });
    expect(fixture.mutations()).toHaveLength(0);
  });

  it.each([408, 500, 503])("classifies a preflight HTTP %s as safely retryable", async (status) => {
    const fixture = harness();
    fixture.gets.set("/user", response({}, status));
    expect(
      await fixture.transport.publishProgressComment(
        createRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({
      state: "failed",
      effect: "not_sent",
      retryable: true,
      reasonCode: `github_http_${status}`,
    });
    expect(fixture.mutations()).toHaveLength(0);
  });

  it.each([401, 403, 404, 422])(
    "classifies mutation HTTP %s as a definite rejection",
    async (status) => {
      const fixture = harness({ mutate: () => response({}, status) });
      expect(
        await fixture.transport.publishProgressComment(
          createRequest(),
          repository,
          workItem(),
          actor,
        ),
      ).toMatchObject({
        state: "failed",
        effect: "rejected",
        retryable: false,
        reasonCode: `github_http_${status}`,
      });
      expect(fixture.mutations()).toHaveLength(1);
    },
  );

  it.each([403, 429])(
    "honors Retry-After on an explicit mutation HTTP %s rate limit",
    async (status) => {
      const fixture = harness({ mutate: () => response({}, status, { "retry-after": "120" }) });
      expect(
        await fixture.transport.publishProgressComment(
          createRequest(),
          repository,
          workItem(),
          actor,
        ),
      ).toMatchObject({
        state: "failed",
        effect: "rejected",
        retryable: true,
        reasonCode: "github_rate_limited",
        retryAfterMs: 120_000,
      });
      expect(fixture.mutations()).toHaveLength(1);
    },
  );

  it("honors an HTTP-date Retry-After before any mutation was sent", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(timestamp));
    const fixture = harness();
    fixture.gets.set(
      "/user",
      response({}, 429, { "retry-after": "Fri, 18 Sep 2026 08:02:00 GMT" }),
    );
    expect(
      await fixture.transport.publishProgressComment(
        createRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({
      state: "failed",
      effect: "not_sent",
      retryable: true,
      reasonCode: "github_rate_limited",
      retryAfterMs: 120_000,
    });
    expect(fixture.mutations()).toHaveLength(0);
  });

  it("preserves the publisher rate-limit reset time", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(timestamp));
    const fixture = harness({
      mutate: () =>
        response({}, 403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Date.parse(timestamp) / 1_000 + 300),
        }),
    });
    expect(
      await fixture.transport.publishProgressComment(
        createRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({
      effect: "rejected",
      retryable: true,
      reasonCode: "github_rate_limited",
      retryAfterMs: 300_000,
    });
    expect(fixture.mutations()).toHaveLength(1);
  });

  it.each([408, 500, 503])(
    "does not treat mutation HTTP %s as permission to resend",
    async (status) => {
      const fixture = harness({ mutate: () => response({}, status) });
      expect(
        await fixture.transport.publishProgressComment(
          createRequest(),
          repository,
          workItem(),
          actor,
        ),
      ).toMatchObject({
        state: "unknown",
        effect: "unknown",
        retryable: false,
        reasonCode: "mutation_response_unknown",
      });
      expect(fixture.mutations()).toHaveLength(1);
    },
  );

  it("keeps a lost write response uncertain without exposing the raw error", async () => {
    const fixture = harness({
      mutate: () => {
        throw new Error("Sensitive synthetic exception");
      },
    });
    const result = await fixture.transport.publishProgressComment(
      createRequest(),
      repository,
      workItem(),
      actor,
    );
    expect(result).toMatchObject({
      state: "unknown",
      effect: "unknown",
      retryable: false,
      reasonCode: "mutation_response_unknown",
    });
    expect(result.message).not.toContain("Sensitive synthetic exception");
    expect(fixture.mutations()).toHaveLength(1);
  });

  it("preserves Retry-After without making an uncertain write safe to repeat", async () => {
    const fixture = harness({ mutate: () => response({}, 503, { "retry-after": "60" }) });
    expect(
      await fixture.transport.publishProgressComment(
        createRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({
      state: "unknown",
      effect: "unknown",
      retryable: false,
      reasonCode: "mutation_response_unknown",
      retryAfterMs: 60_000,
    });
    expect(fixture.mutations()).toHaveLength(1);
  });

  it("treats an invalid successful receipt as uncertain until read-only reconciliation", async () => {
    const fixture = harness({
      mutate: () => response(comment(`Modified receipt\n${marker}`), 201),
    });
    expect(
      await fixture.transport.publishProgressComment(
        createRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({
      state: "unknown",
      effect: "unknown",
      retryable: false,
      reasonCode: "mutation_receipt_unverified",
    });
    expect(fixture.mutations()).toHaveLength(1);
  });

  it("keeps an uncertain PATCH unresolved when the exact previous body is still visible", async () => {
    const fixture = harness();
    expect(
      await fixture.transport.reconcileProgressComment(
        updateRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({
      state: "unknown",
      effect: "unknown",
      retryable: true,
      reasonCode: "previous_body_observed",
      externalId: "810",
    });
    expect(fixture.mutations()).toHaveLength(0);
  });

  it.each([
    [{ body: `Manually edited\n${marker}` }, "conflict_comment_body_changed"],
    [{ body: "Marker removed" }, "conflict_comment_marker_changed"],
    [{ user: { id: 99 } }, "conflict_comment_owner_changed"],
    [
      { issue_url: `https://api.github.com${basePath}/issues/8` },
      "conflict_comment_target_changed",
    ],
    [{ id: 811 }, "conflict_comment_identity_changed"],
  ] as const)(
    "reports a precise conflict for an externally changed comment",
    async (changed, reasonCode) => {
      const fixture = harness();
      fixture.gets.set(`${basePath}/issues/comments/810`, { ...comment(), ...changed });
      expect(
        await fixture.transport.reconcileProgressComment(
          updateRequest(),
          repository,
          workItem(),
          actor,
        ),
      ).toMatchObject({
        state: "unknown",
        effect: "unknown",
        retryable: false,
        reasonCode,
        externalId: "810",
      });
      expect(fixture.mutations()).toHaveLength(0);
    },
  );

  it("classifies a deleted known comment without allowing a replacement POST", async () => {
    const fixture = harness();
    fixture.gets.delete(`${basePath}/issues/comments/810`);
    expect(
      await fixture.transport.reconcileProgressComment(
        updateRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({
      state: "unknown",
      effect: "unknown",
      retryable: false,
      reasonCode: "comment_missing",
      externalId: "810",
    });
    expect(fixture.mutations()).toHaveLength(0);
  });

  it("classifies multiple marker candidates as a conflict even when one has another author", async () => {
    const fixture = harness();
    fixture.gets.set(`${basePath}/issues/7/comments?per_page=100&page=1`, [
      { ...comment(), user: { id: 99 } },
      comment(receivedBody, 811),
    ]);
    expect(
      await fixture.transport.reconcileProgressComment(
        createRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({
      state: "unknown",
      effect: "unknown",
      retryable: false,
      reasonCode: "conflict_multiple_comments",
    });
    expect(fixture.mutations()).toHaveLength(0);
  });

  it("permits only another GET after a transient reconciliation failure", async () => {
    const fixture = harness();
    fixture.gets.set(`${basePath}/issues/comments/810`, response({}, 503));
    expect(
      await fixture.transport.reconcileProgressComment(
        updateRequest(),
        repository,
        workItem(),
        actor,
      ),
    ).toMatchObject({
      state: "unknown",
      effect: "unknown",
      retryable: true,
      reasonCode: "github_http_503",
    });
    expect(fixture.mutations()).toHaveLength(0);
  });
});
