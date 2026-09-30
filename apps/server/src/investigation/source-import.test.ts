import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanonicalResult } from "@agentic-review/codex";
import {
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationInputSnapshotV1,
  type InvestigationTaskV1,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindInvestigationPlanExecution,
  type InvestigationProgressCommentClassifier,
  InvestigationSourceImporter,
  type InvestigationTrustedExecutionBinding,
  loadInvestigationExecutionBindings,
} from "../../dist/investigation/source-import.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type { InvestigationOperatorPrincipal } from "../../dist/investigation/types.js";

const stores: InvestigationStore[] = [];
const directories: string[] = [];
const repository = { id: "repo-1", fullName: "fixture/repository", githubRepositoryId: 123 };
const operator: InvestigationOperatorPrincipal = {
  id: "operator-1",
  displayName: "Operator",
  repositoryIds: [repository.id],
  permissions: ["repository:manage", "task:create"],
  actionCapabilities: [],
  allowRepositoryExecution: true,
};
const sha = "a".repeat(40);

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function harness(
  options: {
    kind?: "issue" | "pull_request";
    comments?: number;
    maximumBytes?: number;
    maximumPages?: number;
    anonymous?: boolean;
    classifyProgressComment?: InvestigationProgressCommentClassifier;
    override?: (
      path: string,
      ordinal: number,
      upstream: Record<string, unknown>,
    ) => Response | undefined;
  } = {},
) {
  const store = new InvestigationStore();
  stores.push(store);
  store.insert("repositories", repository.id, repository);
  const count = options.comments ?? 101;
  const calls: { path: string; method: string | undefined }[] = [];
  const authorizations: (string | null)[] = [];
  const upstream = {
    id: 77,
    number: 7,
    title: "Complete reported behavior",
    body: "Full original body\nincluding every reproduction detail.",
    state: "open",
    assignees: [{ id: 55, login: "configured-operator" }],
    comments: count,
    updated_at: "2026-09-15T10:00:00.000Z",
    ...(options.kind === "pull_request"
      ? {
          base: { sha: "b".repeat(40), repo: { id: 123 } },
          head: { sha },
          review_comments: 1,
          merged_at: null,
        }
      : {}),
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.github.com");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    const path = `${url.pathname}${url.search}`;
    calls.push({ path, method: init?.method });
    authorizations.push(new Headers(init?.headers).get("authorization"));
    const overridden = options.override?.(
      path,
      calls.filter((call) => call.path === path).length,
      upstream,
    );
    if (overridden !== undefined) return overridden;
    if (path === "/user") return Response.json({ id: 55 });
    if (path === "/repos/fixture/repository")
      return Response.json({ id: 123, full_name: repository.fullName, private: false });
    if (
      url.pathname === "/repos/fixture/repository/issues/7" ||
      url.pathname === "/repos/fixture/repository/pulls/7"
    )
      return Response.json(upstream);
    if (url.pathname === `/repos/fixture/repository/commits/${sha}`) return Response.json({ sha });
    if (url.pathname === "/repos/fixture/repository/issues/7/comments") {
      const page = Number(url.searchParams.get("page"));
      const start = (page - 1) * 100;
      const comments = Array.from(
        { length: Math.max(0, Math.min(100, count - start)) },
        (_, index) => ({ id: start + index + 1, body: `Complete comment ${start + index + 1}` }),
      );
      return Response.json(
        comments,
        start + comments.length < count
          ? {
              headers: {
                link: `<https://api.github.com/repos/fixture/repository/issues/7/comments?per_page=100&page=${page + 1}>; rel="next"`,
              },
            }
          : {},
      );
    }
    if (url.pathname === "/repos/fixture/repository/pulls/7/comments")
      return Response.json([{ id: 301, body: "Full inline review feedback" }]);
    if (url.pathname === "/repos/fixture/repository/pulls/7/reviews")
      return Response.json([{ id: 401, body: "Full overall review feedback" }]);
    throw new Error(`Unexpected fake request: ${path}`);
  };
  const importer = new InvestigationSourceImporter({
    store,
    ...(options.anonymous === true
      ? {}
      : { github: { token: "synthetic-read-token", expectedGitHubUserId: 55 } }),
    fetch,
    ...(options.maximumBytes === undefined ? {} : { maximumBytes: options.maximumBytes }),
    ...(options.maximumPages === undefined ? {} : { maximumPages: options.maximumPages }),
    ...(options.classifyProgressComment === undefined
      ? {}
      : { classifyProgressComment: options.classifyProgressComment }),
  });
  return { store, importer, calls, authorizations, upstream };
}

describe("read-only GitHub source import", () => {
  it("imports every Issue comment page and preserves the complete frozen task input", async () => {
    const { store, importer, calls, upstream } = harness();
    const imported = await importer.importWorkItem(operator, repository.id, {
      kind: "issue",
      number: 7,
    });
    expect(imported.commentsCount).toBe(101);
    expect(imported.workItem.body).toBe(upstream.body);
    expect(imported.workItem.subject.revisionKey).toBe(
      createHash("sha256")
        .update(
          JSON.stringify([upstream.title, upstream.body, upstream.state, upstream.updated_at]),
        )
        .digest("hex"),
    );
    expect(calls.filter((call) => call.path.includes("/comments?"))).toHaveLength(2);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    const { task: baseTask } = createInvestigationFixture("bug");
    const task: InvestigationTaskV1 = {
      ...baseTask,
      repository,
      workItem: imported.workItem,
      subjectRef: imported.workItem.subject.id,
      subjects: [imported.workItem.subject],
    };
    const prepared = await importer.prepareTaskInput(task, imported.workItem, null, operator);
    expect(prepared.inputSnapshot.body).toBe(upstream.body);
    expect(prepared.inputSnapshot.comments.at(-1)).toEqual({
      id: "issue-comment:101",
      body: "Complete comment 101",
    });
    expect(prepared.inputSnapshot.comments).toHaveLength(101);
    expect(prepared.inputSnapshot.source).toBeNull();
    expect(prepared.execution).toBeNull();
    prepared.inputSnapshot.comments[0]!.body = "Modified caller copy";
    const again = await importer.prepareTaskInput(task, imported.workItem, null, operator);
    expect(again.inputSnapshot.comments[0]?.body).toBe("Complete comment 1");
    expect(store.get("sourceSnapshots", imported.snapshotRef.id)).toMatchObject({
      digest: imported.snapshotRef.digest,
    });
  });

  it.each([
    { mode: "authenticated private", anonymous: false, private: true },
    { mode: "anonymous public", anonymous: true, private: false },
  ])(
    "imports the complete PR conversation with $mode reads and an exact base/head revision",
    async ({ anonymous, private: isPrivate }) => {
      const { store, importer, calls, authorizations, upstream } = harness({
        kind: "pull_request",
        anonymous,
        override: (path) =>
          path === "/repos/fixture/repository"
            ? Response.json({ id: 123, full_name: repository.fullName, private: isPrivate })
            : undefined,
      });
      const result = await importer.importWorkItem(operator, repository.id, {
        kind: "pull_request",
        number: 7,
      });
      expect(result.commentsCount).toBe(103);
      expect(result.workItem.subject).toMatchObject({
        kind: "original_pr",
        baseSha: "b".repeat(40),
        headSha: sha,
        revisionKey: createHash("sha256")
          .update(`${"b".repeat(40)}\0${sha}`)
          .digest("hex"),
      });
      expect(calls.filter((call) => call.path.includes("/issues/7/comments?"))).toHaveLength(2);
      const { task: baseTask } = createInvestigationFixture("bug");
      const task: InvestigationTaskV1 = {
        ...baseTask,
        repository,
        workItem: result.workItem,
        subjectRef: result.workItem.subject.id,
        subjects: [result.workItem.subject],
      };
      const prepared = await importer.prepareTaskInput(task, result.workItem, null, operator);
      expect(prepared.inputSnapshot).toMatchObject({
        body: upstream.body,
        subjectRef: result.workItem.subject.id,
        subjectRevisionKey: result.workItem.subject.revisionKey,
      });
      expect(prepared.inputSnapshot.comments).toHaveLength(103);
      expect(prepared.inputSnapshot.comments.slice(-3)).toEqual([
        { id: "issue-comment:101", body: "Complete comment 101" },
        { id: "review-comment:301", body: "Full inline review feedback" },
        { id: "review:401", body: "Full overall review feedback" },
      ]);
      expect(store.get("sourceSnapshots", result.snapshotRef.id)).toMatchObject({
        digest: result.snapshotRef.digest,
        inputSnapshot: prepared.inputSnapshot,
      });
      expect(calls.filter((call) => call.path === "/user")).toHaveLength(anonymous ? 0 : 1);
      expect(calls.every((call) => call.method === "GET")).toBe(true);
      expect(authorizations).toEqual(
        calls.map(() => (anonymous ? null : "Bearer synthetic-read-token")),
      );
    },
  );

  it.each(["issue", "pull_request"] as const)(
    "annotates trusted progress publications without changing the complete %s conversation",
    async (kind) => {
      const body = "Complete progress body\n<!-- agentic-review-progress:publication-1 -->";
      const provenance = {
        kind: "agentic_review_progress" as const,
        publicationId: "publication-1",
      };
      const issueUrl = "https://api.github.com/repos/fixture/repository/issues/7";
      const commentIdentity = { user: { id: 55 }, issue_url: issueUrl };
      const sourceComments = [
        { id: 1, body, ...commentIdentity },
        { id: 2, body, ...commentIdentity, provenance },
        {
          id: 3,
          body: "Complete independent reporter comment\nwith more details.",
          user: { id: 99 },
          issue_url: issueUrl,
        },
        { id: 4, body: null, ...commentIdentity },
      ];
      const classified: Parameters<InvestigationProgressCommentClassifier>[] = [];
      const { store, importer, calls } = harness({
        kind,
        comments: sourceComments.length,
        classifyProgressComment: (...args) => {
          classified.push(args);
          return args[2].externalId === "1" ? provenance : undefined;
        },
        override: (path) => {
          if (path === "/repos/fixture/repository/issues/7/comments?per_page=100&page=1")
            return Response.json(sourceComments);
          if (path === "/repos/fixture/repository/pulls/7/comments?per_page=100&page=1")
            return Response.json([{ id: 301, body, ...commentIdentity, provenance }]);
          if (path === "/repos/fixture/repository/pulls/7/reviews?per_page=100&page=1")
            return Response.json([{ id: 401, body, ...commentIdentity, provenance }]);
          return undefined;
        },
      });
      const imported = await importer.importWorkItem(operator, repository.id, { kind, number: 7 });
      const comments = [
        { id: "issue-comment:1", body, provenance },
        { id: "issue-comment:2", body },
        { id: "issue-comment:3", body: sourceComments[2]!.body },
        { id: "issue-comment:4", body: "" },
        ...(kind === "pull_request"
          ? [
              { id: "review-comment:301", body },
              { id: "review:401", body },
            ]
          : []),
      ];
      expect(imported.commentsCount).toBe(comments.length);
      expect(classified).toEqual(
        sourceComments.map((comment) => [
          repository,
          { kind, number: 7, githubWorkItemId: 77 },
          {
            externalId: String(comment.id),
            authorUserId: comment.user.id,
            body: comment.body ?? "",
            issueUrl,
          },
        ]),
      );
      expect(
        store.get<{ inputSnapshot: InvestigationInputSnapshotV1 }>(
          "sourceSnapshots",
          imported.snapshotRef.id,
        )?.inputSnapshot.comments,
      ).toEqual(comments);
      const { task: baseTask } = createInvestigationFixture("bug");
      const prepared = await importer.prepareTaskInput(
        {
          ...baseTask,
          repository,
          workItem: imported.workItem,
          subjectRef: imported.workItem.subject.id,
          subjects: [imported.workItem.subject],
        },
        imported.workItem,
        null,
        operator,
      );
      expect(prepared.inputSnapshot.comments).toEqual(comments);
      expect(calls.every((call) => call.method === "GET")).toBe(true);
    },
  );

  it("does not infer trusted provenance from an imported marker or metadata", async () => {
    const body = "Copied progress body\n<!-- agentic-review-progress:publication-1 -->";
    const { importer, store } = harness({
      comments: 1,
      override: (path) =>
        path === "/repos/fixture/repository/issues/7/comments?per_page=100&page=1"
          ? Response.json([
              {
                id: 1,
                body,
                user: { id: 55 },
                issue_url: "https://api.github.com/repos/fixture/repository/issues/7",
                provenance: { kind: "agentic_review_progress", publicationId: "publication-1" },
              },
            ])
          : undefined,
    });
    const imported = await importer.importWorkItem(operator, repository.id, {
      kind: "issue",
      number: 7,
    });
    expect(
      store.get<{ inputSnapshot: InvestigationInputSnapshotV1 }>(
        "sourceSnapshots",
        imported.snapshotRef.id,
      )?.inputSnapshot.comments,
    ).toEqual([{ id: "issue-comment:1", body }]);
  });

  it("preserves comments with missing or invalid optional classification identities", async () => {
    const issueUrl = "https://api.github.com/repos/fixture/repository/issues/7";
    const identities = [
      { issue_url: issueUrl },
      { user: null, issue_url: issueUrl },
      { user: [], issue_url: issueUrl },
      { user: {}, issue_url: issueUrl },
      { user: { id: 0 }, issue_url: issueUrl },
      { user: { id: "55" }, issue_url: issueUrl },
      { user: { id: Number.MAX_SAFE_INTEGER + 1 }, issue_url: issueUrl },
      { user: { id: 55 } },
      { user: { id: 55 }, issue_url: "" },
      { user: { id: 55 }, issue_url: 7 },
    ];
    const sourceComments = identities.map((identity, index) => ({
      id: index + 1,
      body: `Complete unclassified comment ${index + 1}`,
      ...identity,
    }));
    const { importer, store } = harness({
      comments: sourceComments.length,
      classifyProgressComment: () => {
        throw new Error("Incomplete identities must not be classified.");
      },
      override: (path) =>
        path === "/repos/fixture/repository/issues/7/comments?per_page=100&page=1"
          ? Response.json(sourceComments)
          : undefined,
    });
    const imported = await importer.importWorkItem(operator, repository.id, {
      kind: "issue",
      number: 7,
    });
    expect(imported.commentsCount).toBe(sourceComments.length);
    expect(
      store.get<{ inputSnapshot: InvestigationInputSnapshotV1 }>(
        "sourceSnapshots",
        imported.snapshotRef.id,
      )?.inputSnapshot.comments,
    ).toEqual(
      sourceComments.map((comment) => ({
        id: `issue-comment:${comment.id}`,
        body: comment.body,
      })),
    );
  });

  it.each([false, true])(
    "preserves repository identity and operator scope checks with anonymous=%s",
    async (anonymous) => {
      for (const { actor, code } of [
        { actor: { ...operator, repositoryIds: [] }, code: "repository_forbidden" },
        {
          actor: { ...operator, permissions: ["task:create"] as const },
          code: "permission_denied",
        },
      ]) {
        const scoped = harness({ anonymous });
        await expect(
          scoped.importer.importWorkItem(actor, repository.id, { kind: "issue", number: 7 }),
        ).rejects.toMatchObject({ code, statusCode: 403 });
        expect(scoped.calls).toHaveLength(0);
        expect(scoped.store.list("workItems")).toEqual([]);
        expect(scoped.store.list("sourceSnapshots")).toEqual([]);
      }
      for (const identity of [
        { id: 999, full_name: repository.fullName },
        { id: "123", full_name: repository.fullName },
        { id: 123, full_name: "fixture/another-repository" },
      ]) {
        const wrongRepository = harness({
          anonymous,
          override: (path) =>
            path === "/repos/fixture/repository"
              ? Response.json({ ...identity, private: false })
              : undefined,
        });
        await expect(
          wrongRepository.importer.importWorkItem(operator, repository.id, {
            kind: "issue",
            number: 7,
          }),
        ).rejects.toMatchObject({ code: "source_repository_mismatch", statusCode: 409 });
        expect(wrongRepository.calls.map((call) => call.path)).toEqual(
          anonymous ? ["/repos/fixture/repository"] : ["/user", "/repos/fixture/repository"],
        );
        expect(wrongRepository.store.list("workItems")).toEqual([]);
        expect(wrongRepository.store.list("sourceSnapshots")).toEqual([]);
      }
    },
  );

  it.each([
    { visibility: "private", private: true },
    { visibility: "missing", private: undefined },
    { visibility: "null", private: null },
    { visibility: "string false", private: "false" },
    { visibility: "numeric zero", private: 0 },
  ])("rejects anonymous imports with $visibility repository visibility", async (visibility) => {
    const { importer, store, calls, authorizations } = harness({
      anonymous: true,
      override: (path) =>
        path === "/repos/fixture/repository"
          ? Response.json({ id: 123, full_name: repository.fullName, private: visibility.private })
          : undefined,
    });
    await expect(
      importer.importWorkItem(operator, repository.id, { kind: "issue", number: 7 }),
    ).rejects.toMatchObject({ code: "source_repository_not_public", statusCode: 403 });
    expect(calls).toEqual([{ path: "/repos/fixture/repository", method: "GET" }]);
    expect(authorizations).toEqual([null]);
    expect(store.list("workItems")).toEqual([]);
    expect(store.list("sourceSnapshots")).toEqual([]);
  });

  it.each([
    { failure: "wrong account", account: { id: 99 }, responseStatus: 200, statusCode: 403 },
    { failure: "nonnumeric account", account: { id: "55" }, responseStatus: 200, statusCode: 403 },
    { failure: "rejected credential", account: {}, responseStatus: 401, statusCode: 503 },
  ])("does not fall back to anonymous reads for a configured $failure", async (failure) => {
    const { importer, store, calls, authorizations } = harness({
      override: (path) =>
        path === "/user"
          ? Response.json(failure.account, { status: failure.responseStatus })
          : undefined,
    });
    await expect(
      importer.importWorkItem(operator, repository.id, { kind: "issue", number: 7 }),
    ).rejects.toMatchObject({
      code: failure.responseStatus === 200 ? "source_account_mismatch" : "source_read_failed",
      statusCode: failure.statusCode,
    });
    expect(calls).toEqual([{ path: "/user", method: "GET" }]);
    expect(authorizations).toEqual(["Bearer synthetic-read-token"]);
    expect(store.list("workItems")).toEqual([]);
    expect(store.list("sourceSnapshots")).toEqual([]);
  });

  it("fails budget exhaustion or a changing target without storing truncated observations", async () => {
    for (const options of [{ maximumBytes: 10 }, { maximumPages: 1 }]) {
      const { importer, store } = harness(options);
      await expect(
        importer.importWorkItem(operator, repository.id, { kind: "issue", number: 7 }),
      ).rejects.toMatchObject({ code: "source_budget_exceeded" });
      expect(store.list("workItems")).toEqual([]);
      expect(store.list("sourceSnapshots")).toEqual([]);
    }
    const changed = harness({
      override: (path, ordinal) =>
        path === "/repos/fixture/repository/issues/7" && ordinal === 2
          ? Response.json({
              number: 7,
              title: "Changed",
              body: "Changed",
              state: "open",
              comments: 101,
              updated_at: "2026-09-15T10:01:00.000Z",
            })
          : undefined,
    });
    await expect(
      changed.importer.importWorkItem(operator, repository.id, { kind: "issue", number: 7 }),
    ).rejects.toMatchObject({ code: "source_changed_during_import" });
    expect(changed.store.list("sourceSnapshots")).toEqual([]);
  });

  it("rejects unexpected pagination origins without following their links", async () => {
    const { importer, calls } = harness({
      override: (path) =>
        path.includes("/comments?")
          ? Response.json([{ id: 1, body: "One comment" }], {
              headers: { link: '<https://attacker.example/steal?per_page=100&page=2>; rel="next"' },
            })
          : undefined,
    });
    await expect(
      importer.importWorkItem(operator, repository.id, { kind: "issue", number: 7 }),
    ).rejects.toMatchObject({ code: "invalid_source_pagination" });
    expect(calls.some((call) => call.path.includes("steal"))).toBe(false);
  });

  it("resolves only the explicit exact Issue source commit and preserves Issue context", async () => {
    const { importer } = harness({ comments: 1 });
    const { workItem } = await importer.importWorkItem(operator, repository.id, {
      kind: "issue",
      number: 7,
    });
    const subject = await importer.resolveTaskSource(repository, workItem, sha, operator);
    expect(subject).toMatchObject({
      kind: "source_commit",
      commitSha: sha,
      repositoryId: repository.id,
      workItemId: workItem.id,
    });
    const { task: baseTask } = createInvestigationFixture("bug");
    const task: InvestigationTaskV1 = {
      ...baseTask,
      repository,
      workItem,
      subjectRef: subject.id,
      subjects: [workItem.subject, subject],
    };
    const prepared = await importer.prepareTaskInput(task, workItem, null, operator);
    expect(prepared.inputSnapshot).toMatchObject({
      subjectRef: subject.id,
      subjectRevisionKey: subject.revisionKey,
      body: workItem.body,
      comments: [{ id: "issue-comment:1", body: "Complete comment 1" }],
    });
    const wrong = harness({
      comments: 1,
      override: (path) =>
        path.includes("/commits/") ? Response.json({ sha: "f".repeat(40) }) : undefined,
    });
    await expect(
      wrong.importer.resolveTaskSource(repository, workItem, sha, operator),
    ).rejects.toMatchObject({ code: "source_commit_mismatch" });
  });
});

function webhookExpectation(kind: "issue" | "pull_request") {
  return {
    githubWorkItemId: 77,
    assigneeUserId: 55,
    ...(kind === "pull_request" ? { baseSha: "b".repeat(40), headSha: sha } : {}),
  };
}

describe("assignment-bound Webhook source import", () => {
  it.each(["issue", "pull_request"] as const)(
    "imports an open assigned %s whose identity and revision match the event",
    async (kind) => {
      const { importer, store, calls } = harness({ kind, comments: 1 });
      const imported = await importer.importWorkItem(
        operator,
        repository.id,
        { kind, number: 7 },
        webhookExpectation(kind),
      );
      expect(imported.workItem).toMatchObject({ kind, number: 7, state: "open" });
      expect(store.get("workItems", imported.workItem.id)).toEqual(imported.workItem);
      expect(store.get("sourceSnapshots", imported.snapshotRef.id)).toMatchObject({
        digest: imported.snapshotRef.digest,
      });
      expect(
        calls.filter(
          (call) =>
            call.path === `/repos/fixture/repository/${kind === "issue" ? "issues" : "pulls"}/7`,
        ),
      ).toHaveLength(2);
      expect(calls.every((call) => call.method === "GET")).toBe(true);
    },
  );

  const staleTargets = [
    { change: "unassigned", patch: { assignees: [] } },
    { change: "missing assignment data", patch: { assignees: undefined } },
    {
      change: "assigned to another numeric user with the same login",
      patch: { assignees: [{ id: 99, login: "configured-operator" }] },
    },
    { change: "closed", patch: { state: "closed" } },
    { change: "another work item ID", patch: { id: 88 } },
  ];
  it.each(
    (["issue", "pull_request"] as const).flatMap((kind) =>
      [1, 2].flatMap((ordinal) => staleTargets.map((target) => ({ kind, ordinal, ...target }))),
    ),
  )(
    "rejects $kind with $change on source read $ordinal without persisting a partial snapshot",
    async ({ kind, ordinal, patch }) => {
      const endpoint = `/repos/fixture/repository/${kind === "issue" ? "issues" : "pulls"}/7`;
      const { importer, store, calls } = harness({
        kind,
        comments: 1,
        override: (path, observedOrdinal, upstream) =>
          path === endpoint && observedOrdinal === ordinal
            ? Response.json({ ...upstream, ...patch })
            : undefined,
      });
      await expect(
        importer.importWorkItem(
          operator,
          repository.id,
          { kind, number: 7 },
          webhookExpectation(kind),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(store.list("workItems")).toEqual([]);
      expect(store.list("sourceSnapshots")).toEqual([]);
      expect(calls.filter((call) => call.path === endpoint)).toHaveLength(ordinal);
      if (ordinal === 1)
        expect(calls.filter((call) => call.path.includes("/comments?"))).toHaveLength(0);
    },
  );

  it.each(
    [1, 2].flatMap((ordinal) =>
      [
        { change: "base SHA", patch: { base: { sha: "c".repeat(40), repo: { id: 123 } } } },
        { change: "head SHA", patch: { head: { sha: "c".repeat(40) } } },
        { change: "merge timestamp", patch: { merged_at: "2026-09-15T10:01:00.000Z" } },
        { change: "merged flag", patch: { merged: true } },
      ].map((target) => ({ ordinal, ...target })),
    ),
  )("rejects a stale PR $change on source read $ordinal", async ({ ordinal, patch }) => {
    const endpoint = "/repos/fixture/repository/pulls/7";
    const { importer, store, calls } = harness({
      kind: "pull_request",
      comments: 1,
      override: (path, observedOrdinal, upstream) =>
        path === endpoint && observedOrdinal === ordinal
          ? Response.json({ ...upstream, ...patch })
          : undefined,
    });
    await expect(
      importer.importWorkItem(
        operator,
        repository.id,
        { kind: "pull_request", number: 7 },
        webhookExpectation("pull_request"),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(store.list("workItems")).toEqual([]);
    expect(store.list("sourceSnapshots")).toEqual([]);
    expect(calls.filter((call) => call.path === endpoint)).toHaveLength(ordinal);
    if (ordinal === 1)
      expect(calls.filter((call) => call.path.includes("/comments?"))).toHaveLength(0);
  });

  it("uses the assignee numeric identity when the login changes between source reads", async () => {
    const { importer } = harness({
      comments: 1,
      override: (path, ordinal, upstream) =>
        path === "/repos/fixture/repository/issues/7" && ordinal === 2
          ? Response.json({
              ...upstream,
              assignees: [{ id: 55, login: "renamed-configured-operator" }],
            })
          : undefined,
    });
    const imported = await importer.importWorkItem(
      operator,
      repository.id,
      { kind: "issue", number: 7 },
      webhookExpectation("issue"),
    );
    expect(imported.workItem.state).toBe("open");
  });

  it.each([
    { name: "null expectation", kind: "issue" as const, expectation: null },
    { name: "missing work item ID", kind: "issue" as const, expectation: { assigneeUserId: 55 } },
    { name: "missing assignee ID", kind: "issue" as const, expectation: { githubWorkItemId: 77 } },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "77"].map((githubWorkItemId) => ({
      name: `invalid work item ID ${githubWorkItemId}`,
      kind: "issue" as const,
      expectation: { ...webhookExpectation("issue"), githubWorkItemId },
    })),
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "55"].map((assigneeUserId) => ({
      name: `invalid assignee ID ${assigneeUserId}`,
      kind: "issue" as const,
      expectation: { ...webhookExpectation("issue"), assigneeUserId },
    })),
    ...[{ baseSha: sha }, { headSha: sha }, { baseSha: sha, headSha: sha }].map((revision) => ({
      name: `unexpected Issue revision ${Object.keys(revision).join("/")}`,
      kind: "issue" as const,
      expectation: { ...webhookExpectation("issue"), ...revision },
    })),
    ...[
      {},
      { baseSha: "b".repeat(40) },
      { headSha: sha },
      { baseSha: "not-a-sha", headSha: sha },
      { baseSha: "b".repeat(40), headSha: "not-a-sha" },
    ].map((revision) => ({
      name: `missing or invalid PR revision ${JSON.stringify(revision)}`,
      kind: "pull_request" as const,
      expectation: { ...webhookExpectation("issue"), ...revision },
    })),
  ])("rejects $name before reading or persisting source", async ({ kind, expectation }) => {
    const { importer, store, calls } = harness({ kind, comments: 1 });
    await expect(
      importer.importWorkItem(
        operator,
        repository.id,
        { kind, number: 7 },
        expectation as Parameters<InvestigationSourceImporter["importWorkItem"]>[3],
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(calls).toHaveLength(0);
    expect(store.list("workItems")).toEqual([]);
    expect(store.list("sourceSnapshots")).toEqual([]);
  });

  it("preserves existing work item and snapshot records when assignment is lost during reimport", async () => {
    const { importer, store, upstream } = harness({
      comments: 1,
      override: (path, ordinal, source) =>
        path === "/repos/fixture/repository/issues/7" && ordinal === 4
          ? Response.json({ ...source, assignees: [] })
          : undefined,
    });
    await importer.importWorkItem(
      operator,
      repository.id,
      { kind: "issue", number: 7 },
      webhookExpectation("issue"),
    );
    const workItems = store.list("workItems");
    const snapshots = store.list("sourceSnapshots");
    upstream.title = "New title awaiting a consistent import";
    upstream.body = "New complete source body";
    upstream.updated_at = "2026-09-15T10:02:00.000Z";
    await expect(
      importer.importWorkItem(
        operator,
        repository.id,
        { kind: "issue", number: 7 },
        webhookExpectation("issue"),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(store.list("workItems")).toEqual(workItems);
    expect(store.list("sourceSnapshots")).toEqual(snapshots);
  });

  it.each(["issue", "pull_request"] as const)(
    "preserves three-argument manual import of a closed unassigned %s",
    async (kind) => {
      const { importer, upstream } = harness({ kind, comments: 1 });
      upstream.state = "closed";
      upstream.assignees = [];
      const imported = await importer.importWorkItem(operator, repository.id, { kind, number: 7 });
      expect(imported.workItem.state).toBe("closed");
    },
  );

  it.each(["issue", "pull_request"] as const)(
    "rechecks a saved %s assignment without reading comments or saving source",
    async (kind) => {
      const { importer, store, calls } = harness({ kind, comments: 1 });
      await expect(
        importer.verifyAssignment(
          operator,
          repository.id,
          { kind, number: 7 },
          webhookExpectation(kind),
        ),
      ).resolves.toBeUndefined();
      expect(calls).toEqual([
        { path: "/user", method: "GET" },
        { path: "/repos/fixture/repository", method: "GET" },
        {
          path: `/repos/fixture/repository/${kind === "issue" ? "issues" : "pulls"}/7`,
          method: "GET",
        },
      ]);
      expect(store.list("workItems")).toEqual([]);
      expect(store.list("sourceSnapshots")).toEqual([]);
    },
  );

  it.each(["issue", "pull_request"] as const)(
    "rejects a removed %s assignment during recheck without importing source",
    async (kind) => {
      const { importer, store, calls, upstream } = harness({ kind, comments: 1 });
      upstream.assignees = [];
      await expect(
        importer.verifyAssignment(
          operator,
          repository.id,
          { kind, number: 7 },
          webhookExpectation(kind),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(calls).toEqual([
        { path: "/user", method: "GET" },
        { path: "/repos/fixture/repository", method: "GET" },
        {
          path: `/repos/fixture/repository/${kind === "issue" ? "issues" : "pulls"}/7`,
          method: "GET",
        },
      ]);
      expect(store.list("workItems")).toEqual([]);
      expect(store.list("sourceSnapshots")).toEqual([]);
    },
  );
});

function planFixture() {
  const fixture = createInvestigationFixture("pr");
  const plan = fixture.result.plans[0]!;
  const actor = { ...operator, repositoryIds: [fixture.task.repository.id] };
  const task: InvestigationTaskV1 = {
    ...fixture.task,
    kind: "pr-verify",
    planRef: { id: plan.id, version: plan.version, digest: plan.digest },
    executionPolicy: {
      mode: "execute",
      allowRepositoryExecution: true,
      authorizationRef: actor.id,
      allowedSubjectRefs: [fixture.task.subjectRef],
    },
  };
  const binding: InvestigationTrustedExecutionBinding = {
    repositoryId: task.repository.id,
    planRef: { id: plan.id, version: plan.version, digest: plan.digest },
    planKind: "verification",
    satisfiedPrerequisiteRefs: plan.prerequisites.map((entry) => entry.id),
    steps: plan.steps.map((step) => ({
      stepId: step.id,
      operation: {
        kind: "command",
        executableId: "trusted-test-runner",
        arguments: ["--fixed-scenario"],
        workingDirectory: ".",
        expectedExitCode: 0,
      },
    })),
  };
  return { task, plan, actor, binding, result: fixture.result };
}

function recipePlanFixture() {
  const fixture = planFixture();
  const { task, plan } = fixture;
  task.repository.fullName = "microsoft/PowerToys";
  plan.prerequisites = [];
  plan.steps = [
    {
      id: "convert-square-mile",
      description: "Verify square-mile conversion in PowerToys Run.",
      expectedObservation: "The query and converted result are visible.",
      checkIds: ["query-visible", "result-visible"],
      recipe: {
        request: {
          recipeId: "powertoys-run-query",
          plugin: "UnitConverter",
          scenarios: [
            {
              query: "%% 10 sqmi in sqkm",
              feature: {
                id: "square-mile",
                title: "Square-mile conversion",
                paths: [
                  "src/modules/launcher/Plugins/Community.PowerToys.Run.Plugin.UnitConverter/InputInterpreter.cs",
                ],
                scenario: "Convert ten square miles to square kilometres.",
                userVisible: true,
                assertions: [
                  {
                    id: "query",
                    kind: "ui",
                    description: "The exact conversion query is entered.",
                    selector: { automationId: "QueryTextBox" },
                    assertion: {
                      property: "value",
                      expected: "%% 10 sqmi in sqkm",
                      match: "equals",
                    },
                  },
                  {
                    id: "result",
                    kind: "ui",
                    description: "The square-kilometre result is visible.",
                    selector: { name: "25.89988110336" },
                    assertion: {
                      property: "text",
                      expected: "25.89988110336",
                      match: "contains",
                    },
                  },
                ],
              },
            },
          ],
        },
        checks: [
          {
            checkId: "query-visible",
            featureId: "square-mile",
            assertionId: "query",
            scenarioId: "sqmi-to-sqkm",
          },
          {
            checkId: "result-visible",
            featureId: "square-mile",
            assertionId: "result",
            scenarioId: "sqmi-to-sqkm",
          },
        ],
      },
    },
  ];
  const { digest: _digest, state: _state, sourceReportRef: _sourceReportRef, ...content } = plan;
  plan.digest = createCanonicalResult(content).sha256;
  task.planRef = { id: plan.id, version: plan.version, digest: plan.digest };
  return {
    ...fixture,
    binding: {
      ...fixture.binding,
      planRef: task.planRef,
      satisfiedPrerequisiteRefs: [],
      steps: [{ ...fixture.binding.steps[0]!, stepId: plan.steps[0]!.id }],
    },
  };
}

function issueAgentPlanFixture(
  taskKind: "issue-verify" | "reproduction-setup" = "issue-verify",
  sourceKind: "source_commit" | "local_patch" = "source_commit",
) {
  const fixture = planFixture();
  const { task, plan } = fixture;
  task.kind = taskKind;
  task.workItem.kind = "issue";
  task.repository.fullName = "fixture/PowerToys";
  const base = {
    id: sourceKind === "local_patch" ? "issue-source-base" : task.subjectRef,
    kind: "source_commit" as const,
    repositoryId: task.repository.id,
    workItemId: task.workItem.id,
    revisionKey: "7".repeat(64),
    commitSha: "8".repeat(40),
  };
  task.subjects =
    sourceKind === "source_commit"
      ? [base]
      : [
          base,
          {
            id: task.subjectRef,
            kind: "local_patch",
            repositoryId: task.repository.id,
            workItemId: task.workItem.id,
            revisionKey: "9".repeat(64),
            baseSubjectRef: base.id,
            baseSha: base.commitSha,
            patchDigest: "a".repeat(64),
            artifactRef: "issue-patch-artifact",
          },
        ];
  plan.kind = taskKind === "issue-verify" ? "verification" : "reproduction";
  plan.prerequisites = [];
  plan.steps = [
    {
      id: "module-reported-behavior",
      description: "Build and exercise the reported FancyZones behavior in the actual product.",
      expectedObservation:
        "The observed result is recorded with the exact source and runtime evidence.",
      checkIds: ["reported-behavior", "existing-regression-test"],
    },
    {
      id: "module-state-afterward",
      description: "Inspect the actual product state after exercising the reported behavior.",
      expectedObservation: "The state matches the saved acceptance criteria.",
      checkIds: ["state-afterward"],
    },
  ];
  const { digest: _digest, state: _state, sourceReportRef: _sourceReportRef, ...content } = plan;
  plan.digest = createCanonicalResult(content).sha256;
  task.planRef = { id: plan.id, version: plan.version, digest: plan.digest };
  fixture.binding.planRef = task.planRef;
  fixture.binding.planKind = plan.kind;
  fixture.binding.satisfiedPrerequisiteRefs = [];
  fixture.binding.steps = plan.steps.map((step) => ({
    stepId: step.id,
    operation: {
      kind: "command",
      executableId: "trusted-test-runner",
      arguments: ["--fixed-scenario"],
      workingDirectory: ".",
      expectedExitCode: 0,
    },
  }));
  return fixture;
}

describe("trusted plan execution registry", () => {
  it.each([
    ["issue-verify", "source_commit"],
    ["reproduction-setup", "source_commit"],
    ["issue-verify", "local_patch"],
    ["reproduction-setup", "local_patch"],
  ] as const)("derives generic %s operations on %s without a registry", (taskKind, sourceKind) => {
    const { task, plan, actor } = issueAgentPlanFixture(taskKind, sourceKind);
    const original = structuredClone(plan);
    const binding = bindInvestigationPlanExecution(task, plan, actor, []);
    const subject = task.subjects.find((entry) => entry.id === task.subjectRef)!;
    expect(binding).toMatchObject({
      planRef: task.planRef,
      subjectRef: subject.id,
      subjectRevisionKey: subject.revisionKey,
      authorizationRef: actor.id,
      executionPolicyDigest: createCanonicalResult(task.executionPolicy).sha256,
      satisfiedPrerequisiteRefs: [],
    });
    expect(binding?.steps).toEqual(
      plan.steps.map((step) => {
        const operation = { kind: "agent-verify" };
        return {
          stepId: step.id,
          operation,
          digest: createCanonicalResult({ stepId: step.id, operation }).sha256,
        };
      }),
    );
    expect(plan).toEqual(original);
  });

  it("preserves explicit Issue operations and rejects ambiguous registrations", () => {
    const { task, plan, actor, binding } = issueAgentPlanFixture();
    expect(bindInvestigationPlanExecution(task, plan, actor, [binding])?.steps).toEqual(
      binding.steps.map((step) => ({ ...step, digest: createCanonicalResult(step).sha256 })),
    );
    expect(() => bindInvestigationPlanExecution(task, plan, actor, [binding, binding])).toThrow(
      expect.objectContaining({ code: "execution_binding_ambiguous" }),
    );
  });

  it.each([
    "task kind",
    "work item kind",
    "snapshot source",
    "wrong plan kind",
    "prerequisite",
    "empty checks",
    "duplicate checks",
    "recipe step",
  ])("does not infer Issue agent operations with an unsupported %s", (change) => {
    const { task, plan, actor } = issueAgentPlanFixture();
    if (change === "task kind") task.kind = "issue-fix";
    if (change === "work item kind") task.workItem.kind = "pull_request";
    if (change === "snapshot source")
      task.subjects = [
        {
          id: task.subjectRef,
          kind: "issue_snapshot",
          repositoryId: task.repository.id,
          workItemId: task.workItem.id,
          revisionKey: "b".repeat(64),
          snapshotDigest: "c".repeat(64),
        },
      ];
    if (change === "wrong plan kind") plan.kind = "fix";
    if (change === "prerequisite")
      plan.prerequisites.push({
        id: "required-diagnostics",
        kind: "information",
        description: "The reporter must supply a diagnostic file.",
      });
    if (change === "empty checks") plan.steps[1]!.checkIds = [];
    if (change === "duplicate checks") plan.steps[1]!.checkIds = [plan.steps[0]!.checkIds[0]!];
    if (change === "recipe step") plan.steps[0]!.recipe = recipePlanFixture().plan.steps[0]!.recipe;
    expect(() => bindInvestigationPlanExecution(task, plan, actor, [])).toThrow(
      expect.objectContaining({ code: "execution_binding_missing" }),
    );
  });

  it("requires operator execution authority before deriving Issue agent operations", () => {
    const { task, plan, actor } = issueAgentPlanFixture();
    expect(() =>
      bindInvestigationPlanExecution(task, plan, { ...actor, allowRepositoryExecution: false }, []),
    ).toThrow(expect.objectContaining({ code: "execution_not_authorized" }));
  });

  it("derives recipe operations from the complete saved plan without a deployment registry", () => {
    const { task, plan, actor } = recipePlanFixture();
    const original = structuredClone(plan);
    const binding = bindInvestigationPlanExecution(task, plan, actor, []);
    expect(binding).toMatchObject({
      planRef: task.planRef,
      subjectRef: task.subjectRef,
      subjectRevisionKey: task.subjects[0]?.revisionKey,
      authorizationRef: actor.id,
      executionPolicyDigest: createCanonicalResult(task.executionPolicy).sha256,
      satisfiedPrerequisiteRefs: [],
    });
    const operation = { kind: "recipe", recipe: plan.steps[0]!.recipe };
    expect(binding?.steps).toEqual([
      {
        stepId: plan.steps[0]!.id,
        operation,
        digest: createCanonicalResult({ stepId: plan.steps[0]!.id, operation }).sha256,
      },
    ]);
    expect(plan).toEqual(original);
    expect(() =>
      bindInvestigationPlanExecution(task, plan, { ...actor, allowRepositoryExecution: false }, []),
    ).toThrow(expect.objectContaining({ code: "execution_not_authorized" }));
  });

  it("keeps explicit recipe-plan registrations authoritative and rejects ambiguous registrations", () => {
    const { task, plan, actor, binding } = recipePlanFixture();
    expect(
      bindInvestigationPlanExecution(task, plan, actor, [binding])?.steps[0]?.operation,
    ).toEqual(binding.steps[0]!.operation);
    expect(() => bindInvestigationPlanExecution(task, plan, actor, [binding, binding])).toThrow(
      expect.objectContaining({ code: "execution_binding_ambiguous" }),
    );
  });

  it.each([
    "task kind",
    "source",
    "repository",
    "prerequisites",
    "unstructured step",
    "partial plan",
    "check order",
    "duplicate assertion",
    "invalid recipe",
  ])("does not infer a recipe binding with an unsupported %s", (change) => {
    const { task, plan, actor } = recipePlanFixture();
    const recipe = plan.steps[0]!.recipe!;
    if (change === "task kind") task.kind = "issue-verify";
    if (change === "source") task.subjects = [];
    if (change === "repository") task.repository.fullName = "fixture/another-project";
    if (change === "prerequisites")
      plan.prerequisites = [
        { id: "runtime", kind: "environment", description: "Provision a runtime." },
      ];
    if (change === "unstructured step") delete plan.steps[0]!.recipe;
    if (change === "partial plan")
      plan.steps.push({
        id: "another-step",
        description: "Unstructured verification.",
        expectedObservation: "A result.",
        checkIds: ["another-check"],
      });
    if (change === "check order") recipe.checks.reverse();
    if (change === "duplicate assertion")
      recipe.checks[1]!.assertionId = recipe.checks[0]!.assertionId;
    if (change === "invalid recipe") Object.assign(recipe.request, { recipeId: "unknown-recipe" });
    expect(() => bindInvestigationPlanExecution(task, plan, actor, [])).toThrow(
      expect.objectContaining({ code: "execution_binding_missing" }),
    );
  });

  it("reads saved prerequisite acknowledgements without invoking execution or upstream requests", async () => {
    const { task, plan, actor, binding, result } = planFixture();
    plan.prerequisites = ["authorization", "information", "decision"].map((kind) => ({
      id: `trusted-${kind}`,
      kind: kind as "authorization" | "information" | "decision",
      description: `The operator confirmed this ${kind} prerequisite for this saved plan.`,
    }));
    const {
      digest: _digest,
      state: _state,
      sourceReportRef: _sourceReportRef,
      ...planContent
    } = plan;
    plan.digest = createCanonicalResult(planContent).sha256;
    const exactBinding = {
      ...binding,
      planRef: { id: plan.id, version: plan.version, digest: plan.digest },
      satisfiedPrerequisiteRefs: plan.prerequisites.map((entry) => entry.id),
    };
    const store = new InvestigationStore();
    stores.push(store);
    const item = {
      ...task.workItem,
      repositoryId: task.repository.id,
      body: "Synthetic complete source",
      state: "open" as const,
      subject: task.subjects[0]!,
      updatedAt: task.updatedAt,
    };
    let requests = 0;
    const importer = new InvestigationSourceImporter({
      store,
      executionBindings: [exactBinding],
      fetch: async () => {
        requests += 1;
        throw new Error("No upstream request is authorized in this fixture.");
      },
    });
    expect(
      await importer.resolvePlanPrerequisites(task.repository, item, result, plan, actor),
    ).toEqual(exactBinding.satisfiedPrerequisiteRefs);
    expect(requests).toBe(0);
    expect(store.list("tasks")).toEqual([]);
    const { planRef: _planRef, ...profileBinding } = exactBinding;
    const byProfile = new InvestigationSourceImporter({
      store,
      executionBindings: [{ ...profileBinding, profileRef: result.context.profileRef }],
    });
    expect(
      await byProfile.resolvePlanPrerequisites(task.repository, item, result, plan, actor),
    ).toEqual(exactBinding.satisfiedPrerequisiteRefs);
  });

  it("does not acknowledge a mismatched, ambiguous, or unrelated saved plan configuration", async () => {
    const { task, plan, actor, binding, result } = planFixture();
    const store = new InvestigationStore();
    stores.push(store);
    const item = {
      ...task.workItem,
      repositoryId: task.repository.id,
      body: "Synthetic complete source",
      state: "open" as const,
      subject: task.subjects[0]!,
      updatedAt: task.updatedAt,
    };
    const { planRef: _planRef, ...profileBinding } = binding;
    const registrations: InvestigationTrustedExecutionBinding[][] = [
      [],
      [binding, binding],
      [{ ...binding, repositoryId: "another-repository" }],
      [{ ...binding, planRef: { ...binding.planRef!, digest: "0".repeat(64) } }],
      [{ ...profileBinding, profileRef: { ...result.context.profileRef, digest: "0".repeat(64) } }],
      [{ ...binding, satisfiedPrerequisiteRefs: ["not-a-prerequisite-of-this-plan"] }],
      [{ ...binding, steps: [{ ...binding.steps[0]!, stepId: "unrelated-step" }] }],
    ];
    for (const executionBindings of registrations) {
      const importer = new InvestigationSourceImporter({ store, executionBindings });
      expect(
        await importer.resolvePlanPrerequisites(task.repository, item, result, plan, actor),
      ).toEqual([]);
    }
    const importer = new InvestigationSourceImporter({ store, executionBindings: [binding] });
    expect(
      await importer.resolvePlanPrerequisites(
        task.repository,
        { ...item, id: "another-item" },
        result,
        plan,
        actor,
      ),
    ).toEqual([]);
    expect(
      await importer.resolvePlanPrerequisites(
        task.repository,
        item,
        result,
        { ...plan, title: "Altered plan content" },
        actor,
      ),
    ).toEqual([]);
  });

  it("binds fixed operations to the exact plan, source, policy, and actor", () => {
    const { task, plan, actor, binding } = planFixture();
    const result = bindInvestigationPlanExecution(task, plan, actor, [binding]);
    expect(result).toMatchObject({
      planRef: task.planRef,
      subjectRef: task.subjectRef,
      subjectRevisionKey: task.subjects[0]?.revisionKey,
      authorizationRef: actor.id,
      executionPolicyDigest: createCanonicalResult(task.executionPolicy).sha256,
    });
    expect(result?.steps[0]?.digest).toBe(createCanonicalResult(binding.steps[0]).sha256);
    expect(result?.steps[0]?.operation).toEqual(binding.steps[0]?.operation);
  });

  it("rejects missing or ambiguous bindings, missing prerequisites, reordered steps, and denied execution", () => {
    const { task, plan, actor, binding } = planFixture();
    expect(() => bindInvestigationPlanExecution(task, plan, actor, [])).toThrow(
      expect.objectContaining({ code: "execution_binding_missing" }),
    );
    expect(() => bindInvestigationPlanExecution(task, plan, actor, [binding, binding])).toThrow(
      expect.objectContaining({ code: "execution_binding_ambiguous" }),
    );
    expect(() =>
      bindInvestigationPlanExecution(task, plan, actor, [
        { ...binding, satisfiedPrerequisiteRefs: [] },
      ]),
    ).toThrow(expect.objectContaining({ code: "execution_prerequisites_missing" }));
    expect(() =>
      bindInvestigationPlanExecution(task, plan, actor, [
        { ...binding, steps: [{ ...binding.steps[0]!, stepId: "different-step" }] },
      ]),
    ).toThrow(expect.objectContaining({ code: "execution_steps_mismatch" }));
    expect(() =>
      bindInvestigationPlanExecution(task, plan, { ...actor, allowRepositoryExecution: false }, [
        binding,
      ]),
    ).toThrow(expect.objectContaining({ code: "execution_not_authorized" }));
  });

  it("matches a complete trusted profile reference without accepting model-provided command arguments", () => {
    const { task, plan, actor, binding } = planFixture();
    const { planRef: _planRef, ...profileBinding } = binding;
    const result = bindInvestigationPlanExecution(task, plan, actor, [
      { ...profileBinding, profileRef: task.profileRef },
    ]);
    expect(result?.steps[0]?.operation).toEqual(binding.steps[0]?.operation);
    expect(() =>
      bindInvestigationPlanExecution(
        { ...task, profileRef: { ...task.profileRef, digest: "0".repeat(64) } },
        plan,
        actor,
        [{ ...profileBinding, profileRef: task.profileRef }],
      ),
    ).toThrow(expect.objectContaining({ code: "execution_binding_missing" }));
  });

  it("allows an explicit implementation edit without claiming validation and rejects edits in verification", () => {
    const { task, plan, actor, binding } = planFixture();
    const implementationPlan = {
      ...plan,
      kind: "fix" as const,
      steps: plan.steps.map((step) => ({ ...step, checkIds: [] })),
    };
    const implementationTask = { ...task, kind: "issue-fix" as const };
    const editBinding: InvestigationTrustedExecutionBinding = {
      ...binding,
      planKind: "fix",
      steps: [
        {
          stepId: plan.steps[0]!.id,
          operation: { kind: "model-edit", allowedPaths: ["src/fix.ts"] },
        },
      ],
    };
    const result = bindInvestigationPlanExecution(implementationTask, implementationPlan, actor, [
      editBinding,
    ]);
    expect(result?.steps[0]?.operation).toEqual({
      kind: "model-edit",
      allowedPaths: ["src/fix.ts"],
    });
    expect(result).not.toHaveProperty("validation");
    expect(() =>
      bindInvestigationPlanExecution(task, plan, actor, [
        { ...editBinding, planKind: "verification" },
      ]),
    ).toThrow(expect.objectContaining({ code: "execution_edit_binding_mismatch" }));
  });

  it("loads only an explicit trusted registry and rejects path traversal or an unbound entry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "investigation-execution-registry-"));
    directories.push(directory);
    const path = join(directory, "bindings.json");
    const { binding } = planFixture();
    await writeFile(path, JSON.stringify([binding]));
    expect(loadInvestigationExecutionBindings(path)).toEqual([binding]);
    expect(loadInvestigationExecutionBindings(undefined)).toEqual([]);
    await writeFile(
      path,
      JSON.stringify([
        {
          ...binding,
          steps: [
            {
              stepId: binding.steps[0]!.stepId,
              operation: { ...binding.steps[0]!.operation, workingDirectory: "../outside" },
            },
          ],
        },
      ]),
    );
    expect(() => loadInvestigationExecutionBindings(path)).toThrow(
      "relative to the owned source workspace",
    );
    const { planRef: _planRef, ...unbound } = binding;
    await writeFile(path, JSON.stringify([unbound]));
    expect(() => loadInvestigationExecutionBindings(path)).toThrow(
      "exact saved plan or profile reference",
    );
    await writeFile(
      path,
      JSON.stringify([
        {
          ...binding,
          planKind: "fix",
          steps: [
            {
              stepId: binding.steps[0]!.stepId,
              operation: { kind: "model-edit", allowedPaths: ["src/*.ts"] },
            },
          ],
        },
      ]),
    );
    expect(() => loadInvestigationExecutionBindings(path)).toThrow("without traversal or globs");
  });
});
