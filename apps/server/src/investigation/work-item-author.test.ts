import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type {
  InvestigationOperatorPrincipal,
  InvestigationWorkItemRecord,
} from "../../dist/investigation/types.js";
import { InvestigationWorkItemAuthorReader } from "../../dist/investigation/work-item-author.js";

const repository = { id: "repo-1", fullName: "fixture/project", githubRepositoryId: 101 };
const actor: InvestigationOperatorPrincipal = {
  id: "operator-1",
  displayName: "Operator",
  repositoryIds: [repository.id],
  permissions: [],
  actionCapabilities: [],
  allowRepositoryExecution: false,
};
const author = {
  githubUserId: 42,
  login: "fixture-author",
  avatarUrl: "https://avatars.githubusercontent.com/u/42",
  htmlUrl: "https://github.com/fixture-author",
};
const stores: InvestigationStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function harness(kind: "issue" | "pull_request" = "issue") {
  const store = new InvestigationStore();
  stores.push(store);
  const item: InvestigationWorkItemRecord = {
    id: "item-1",
    repositoryId: repository.id,
    kind,
    number: 7,
    githubWorkItemId: 70,
    title: "Frozen title",
    body: "Frozen body",
    state: "open",
    updatedAt: "2026-09-01T10:00:00.000Z",
    subject: {
      id: "subject-1",
      repositoryId: repository.id,
      workItemId: "item-1",
      kind: "issue_snapshot",
      revisionKey: "a".repeat(64),
      snapshotDigest: "b".repeat(64),
    },
  };
  store.insert("repositories", repository.id, repository);
  store.insert("workItems", item.id, item);
  store.insert("sourceSnapshots", "snapshot-1", {
    id: "snapshot-1",
    inputSnapshot: { title: item.title, body: item.body },
  });
  const upstream: Record<string, unknown> = {
    id: 70,
    number: 7,
    title: "Current upstream title",
    body: "Current upstream body",
    user: {
      id: author.githubUserId,
      login: author.login,
      avatar_url: author.avatarUrl,
      html_url: author.htmlUrl,
    },
    ...(kind === "pull_request" ? { base: { repo: { id: repository.githubRepositoryId } } } : {}),
  };
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    return Response.json(
      String(input) === "https://api.github.com/repos/fixture/project"
        ? { id: repository.githubRepositoryId, full_name: repository.fullName }
        : upstream,
    );
  });
  let time = Date.parse("2026-10-01T10:00:00.000Z");
  const reader = new InvestigationWorkItemAuthorReader({
    store,
    token: "synthetic-token",
    fetch,
    now: () => time,
  });
  return {
    store,
    item,
    upstream,
    fetch,
    reader,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

describe("read-only historical work item author metadata", () => {
  it("returns saved author metadata without an upstream request", async () => {
    const { store, item, fetch, reader } = harness();
    store.put("workItems", item.id, { ...item, author });
    expect(await reader.read(actor, item.id)).toEqual({
      workItemId: item.id,
      repositoryId: repository.id,
      author,
      source: "stored",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["issue", "pull_request"] as const)(
    "reads a legacy %s author after checking repository and target identities without changing the frozen record",
    async (kind) => {
      const { store, item, fetch, reader } = harness(kind);
      const { githubWorkItemId: _upstreamId, ...legacy } = item;
      store.put("workItems", item.id, legacy);
      const snapshots = store.list("sourceSnapshots");
      const results = await Promise.all([reader.read(actor, item.id), reader.read(actor, item.id)]);
      expect(results[0]).toEqual({
        workItemId: item.id,
        repositoryId: repository.id,
        author,
        source: "github",
      });
      expect(results[1]).toEqual(results[0]);
      expect(fetch.mock.calls.map((call) => call[0])).toEqual([
        "https://api.github.com/repos/fixture/project",
        `https://api.github.com/repos/fixture/project/${kind === "issue" ? "issues" : "pulls"}/7`,
      ]);
      expect(await reader.read(actor, item.id)).toEqual(results[0]);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(store.get("workItems", item.id)).toEqual(legacy);
      expect(store.list("sourceSnapshots")).toEqual(snapshots);
    },
  );

  it("denies hidden or missing work items before contacting GitHub", async () => {
    const { item, fetch, reader } = harness();
    await expect(reader.read({ ...actor, repositoryIds: [] }, item.id)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(reader.read(actor, "missing-item")).rejects.toMatchObject({ statusCode: 404 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not cache an author under a different saved repository identity", async () => {
    const { store, item, fetch, reader } = harness();
    expect((await reader.read(actor, item.id)).source).toBe("github");
    store.put("repositories", repository.id, { ...repository, githubRepositoryId: 999 });
    expect(await reader.read(actor, item.id)).toMatchObject({
      author: null,
      source: "unavailable",
      reason: "github_repository_mismatch",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("accepts GitHub repository name casing while keeping the numeric repository identity exact", async () => {
    const { item, fetch, reader } = harness();
    fetch.mockResolvedValueOnce(
      Response.json({ id: repository.githubRepositoryId, full_name: "Fixture/Project" }),
    );
    expect((await reader.read(actor, item.id)).source).toBe("github");
  });

  it("refreshes live display metadata after the short cache expires without changing the historical record", async () => {
    const { store, item, upstream, fetch, reader, advance } = harness();
    await reader.read(actor, item.id);
    upstream.user = { id: author.githubUserId, login: "renamed-author" };
    advance(5 * 60_000 + 1);
    const refreshed = await reader.read(actor, item.id);
    expect(refreshed).toMatchObject({
      source: "github",
      author: { githubUserId: author.githubUserId, login: "renamed-author" },
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(store.get("workItems", item.id)).toEqual(item);
  });

  it.each([{ number: 8 }, { id: 71 }, { pull_request: {} }])(
    "rejects an upstream Issue with a mismatched target before projecting its user",
    async (mismatch) => {
      const { item, upstream, reader } = harness();
      Object.assign(upstream, mismatch);
      expect(await reader.read(actor, item.id)).toMatchObject({
        author: null,
        source: "unavailable",
        reason: "github_work_item_mismatch",
      });
    },
  );

  it("rejects a PR whose base repository differs from the saved repository", async () => {
    const { item, upstream, reader } = harness("pull_request");
    upstream.base = { repo: { id: 999 } };
    expect(await reader.read(actor, item.id)).toMatchObject({
      source: "unavailable",
      reason: "github_work_item_mismatch",
    });
  });

  it("briefly caches unavailable observations and retries after expiry without storing fabricated authors", async () => {
    const { store, item, fetch, reader, advance } = harness();
    fetch.mockResolvedValue(Response.json({}, { status: 503 }));
    expect(await reader.read(actor, item.id)).toMatchObject({
      author: null,
      source: "unavailable",
      reason: "github_repository_unavailable",
    });
    await reader.read(actor, item.id);
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(30_001);
    await reader.read(actor, item.id);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.get<InvestigationWorkItemRecord>("workItems", item.id)?.author).toBeUndefined();
  });
});
