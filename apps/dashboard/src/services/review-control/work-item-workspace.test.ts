import type {
  DashboardJobListItem,
  DashboardRequestEpochSummary,
  DashboardWorkItemListItem,
  GitHubWorkItemKind,
} from "@agentic-review/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewControlProtocolError, ReviewControlRequestError } from "./errors";
import { HttpReviewControlAdapter } from "./http-adapter";
import { mapJobListResponse, mapWorkItemListResponse } from "./http-mappers";
import { jobs, workItems } from "./mock/fixtures";
import { MockReviewControlAdapter } from "./mock/mock-adapter";

const observedAt = "2026-09-06T01:00:00.000Z";
const workItemKinds = ["pull_request", "issue"] as const;
const repositoryIds = [...new Set(workItems.map((item) => item.repositoryId))];

const wireWorkItem = (kind: GitHubWorkItemKind): DashboardWorkItemListItem => ({
  id: `item-${kind}-501`,
  repositoryId: "repo-powertoys",
  kind,
  repository: "microsoft/PowerToys",
  number: 501,
  title: "Restore the selected window after a monitor change",
  author: { githubUserId: 1, login: "contributor" },
  githubUrl: `https://github.com/microsoft/PowerToys/${kind === "issue" ? "issues" : "pull"}/501`,
  trigger: null,
  schedulingActor: null,
  schedulingTarget: null,
  authorization: null,
  authorizationReason: null,
  priority: "normal",
  state: "active",
  stage: "reviewing",
  freshness: "current",
  currentRevision:
    kind === "pull_request"
      ? {
          kind,
          githubRepositoryId: 1,
          githubWorkItemId: 501,
          observedAt,
          sourceUpdatedAt: observedAt,
          revisionKey: "a".repeat(64),
          baseSha: "b".repeat(40),
          headSha: "a".repeat(40),
        }
      : {
          kind,
          githubRepositoryId: 1,
          githubWorkItemId: 501,
          observedAt,
          sourceUpdatedAt: observedAt,
          revisionKey: "c".repeat(64),
          contentDigest: "c".repeat(64),
        },
  reviewedRevisionKey: null,
  activeRequestEpoch: null,
  latestJobId: "job-501",
  latestJobStatus: "running",
  latestJobAttemptCount: 1,
  latestJobAdmission: null,
  workerNodeId: null,
  attentionReason: null,
  updatedAt: observedAt,
});

const wireJob = (): DashboardJobListItem => ({
  id: "job-501",
  repositoryId: "repo-powertoys",
  workItemId: "item-pull_request-501",
  workItemRef: "microsoft/PowerToys#501",
  title: "PR review",
  generation: 1,
  status: "queued",
  admission: {
    state: "admitted",
    attemptBase: 0,
    requestedAt: observedAt,
    admittedAt: observedAt,
    timestampBasis: "recorded",
  },
  phase: null,
  attempt: 0,
  maxAttempts: 3,
  workerNodeId: null,
  leaseGeneration: null,
  leaseExpiresAt: null,
  progressUpdatedAt: null,
  elapsedSeconds: 0,
  targetRevisionKey: "a".repeat(40),
  outcome: null,
  createdAt: observedAt,
  updatedAt: observedAt,
});

const jsonResponse = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

describe("work item workspace response mapping", () => {
  it.each(workItemKinds)("preserves the exact %s revision and authorization epoch", (kind) => {
    const activeRequestEpoch: DashboardRequestEpochSummary = {
      requestEpochId: "epoch:review-501",
      requestKind: kind === "pull_request" ? "review_request" : "assignment",
      sequence: 17,
      status: "active",
      authorization: "allowlisted",
      openedAt: "2026-09-06T00:45:00.000Z",
      closedAt: null,
    };
    const item = wireWorkItem(kind);
    const revisionKey = "d".repeat(64);
    const response = mapWorkItemListResponse({
      items: [
        {
          ...item,
          currentRevision: { ...item.currentRevision, revisionKey },
          activeRequestEpoch,
        },
      ],
      total: 1,
    });

    expect(response.items[0]?.revisionKey).toBe(revisionKey);
    expect(response.items[0]?.activeRequestEpoch).toEqual(activeRequestEpoch);
    if (item.currentRevision.kind === "pull_request") {
      expect(response.items[0]?.headSha).toBe(item.currentRevision.headSha);
      expect(response.items[0]?.revisionKey).not.toBe(item.currentRevision.headSha);
    } else {
      expect(response.items[0]?.revisionKey).not.toBe(item.currentRevision.contentDigest);
      expect(response.items[0]?.headSha).toBeUndefined();
    }
  });

  it("preserves an absent authorization epoch as null", () => {
    const response = mapWorkItemListResponse({ items: [wireWorkItem("issue")], total: 1 });

    expect(response.items[0]?.activeRequestEpoch).toBeNull();
  });

  it("preserves the closure status and timestamps of an authorization epoch", () => {
    const activeRequestEpoch: DashboardRequestEpochSummary = {
      requestEpochId: "epoch:closed-501",
      requestKind: "assignment",
      sequence: 9,
      status: "closed",
      authorization: "self",
      openedAt: "2026-09-05T22:00:00.000Z",
      closedAt: "2026-09-06T00:00:00.000Z",
    };
    const response = mapWorkItemListResponse({
      items: [{ ...wireWorkItem("issue"), activeRequestEpoch }],
      total: 1,
    });

    expect(response.items[0]?.activeRequestEpoch).toEqual(activeRequestEpoch);
  });

  it.each([
    { status: "active", closedAt: observedAt },
    { status: "closed", closedAt: null },
  ])("rejects inconsistent authorization epoch state: %j", ({ status, closedAt }) => {
    expect(() =>
      mapWorkItemListResponse({
        items: [
          {
            ...wireWorkItem("pull_request"),
            activeRequestEpoch: {
              requestEpochId: "epoch:review-501",
              requestKind: "review_request",
              sequence: 1,
              status,
              authorization: "allowlisted",
              openedAt: "2026-09-06T00:45:00.000Z",
              closedAt,
            },
          },
        ],
        total: 1,
      }),
    ).toThrow(ReviewControlProtocolError);
  });

  it.each([undefined, null, "a".repeat(40), "a".repeat(63), "a".repeat(65), "A".repeat(64)])(
    "rejects a missing or noncanonical revision instead of substituting a PR head SHA: %j",
    (revisionKey) => {
      for (const kind of workItemKinds) {
        const item = wireWorkItem(kind);
        expect(() =>
          mapWorkItemListResponse({
            items: [{ ...item, currentRevision: { ...item.currentRevision, revisionKey } }],
            total: 1,
          }),
        ).toThrow(ReviewControlProtocolError);
      }
    },
  );

  it.each(workItemKinds)("preserves %s lifecycle and the latest execution identity", (kind) => {
    const response = mapWorkItemListResponse({ items: [wireWorkItem(kind)], total: 1 });

    expect(response.items[0]).toMatchObject({
      kind,
      repositoryId: "repo-powertoys",
      state: "active",
      stage: "reviewing",
      latestJobId: "job-501",
      latestJobStatus: "running",
    });
  });

  it("keeps an unscheduled issue distinct from an item with a queued execution", () => {
    const response = mapWorkItemListResponse({
      items: [
        {
          ...wireWorkItem("issue"),
          state: "open",
          stage: "not_scheduled",
          latestJobId: null,
          latestJobStatus: null,
          latestJobAttemptCount: null,
          latestJobAdmission: null,
        },
      ],
      total: 1,
    });

    expect(response.items[0]).toMatchObject({ state: "open", trigger: "not_requested" });
    expect(response.items[0]?.latestJobId).toBeUndefined();
    expect(response.items[0]?.latestJobStatus).toBeUndefined();
  });

  it("preserves a failed latest execution even when the workspace stage is done", () => {
    const response = mapWorkItemListResponse({
      items: [
        {
          ...wireWorkItem("pull_request"),
          state: "closed",
          stage: "done",
          latestJobStatus: "dead_letter",
        },
      ],
      total: 1,
    });

    expect(response.items[0]).toMatchObject({
      state: "closed",
      stage: "done",
      latestJobId: "job-501",
      latestJobStatus: "dead_letter",
    });
  });

  it.each([{ state: "merged" }, { latestJobId: "job/501" }, { latestJobStatus: "completed" }])(
    "rejects invalid workspace lifecycle and execution fields: %j",
    (invalidFields) => {
      expect(() =>
        mapWorkItemListResponse({
          items: [{ ...wireWorkItem("pull_request"), ...invalidFields }],
          total: 1,
        }),
      ).toThrow(ReviewControlProtocolError);
    },
  );

  it("preserves the repository identity on execution list items", () => {
    const response = mapJobListResponse({ items: [wireJob()], total: 1 });

    expect(response.items[0]).toMatchObject({
      id: "job-501",
      repositoryId: "repo-powertoys",
      workItemId: "item-pull_request-501",
    });
  });

  it.each([undefined, null, "", "microsoft/PowerToys", "repo-1\n"])(
    "rejects workspace and execution items without a canonical repository identity: %j",
    (repositoryId) => {
      expect(() =>
        mapWorkItemListResponse({
          items: [{ ...wireWorkItem("issue"), repositoryId }],
          total: 1,
        }),
      ).toThrow(ReviewControlProtocolError);
      expect(() =>
        mapJobListResponse({ items: [{ ...wireJob(), repositoryId }], total: 1 }),
      ).toThrow(ReviewControlProtocolError);
    },
  );
});

describe("work item workspace HTTP queries", () => {
  it.each(workItemKinds)(
    "requests only the %s workspace before server pagination",
    async (kind) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        jsonResponse({ items: [], total: 0 }),
      );
      const adapter = new HttpReviewControlAdapter({ fetch });

      await adapter.listWorkItems({ page: 2, pageSize: 20, filters: { kind } });

      expect(fetch).toHaveBeenCalledWith(
        `/api/v1/dashboard/work-items?page=2&pageSize=20&kind=${kind}`,
        expect.objectContaining({ method: "GET" }),
      );
    },
  );

  it("scopes execution history by the exact work item identifier", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ items: [], total: 0 }));
    const adapter = new HttpReviewControlAdapter({ fetch });

    await adapter.listJobs({
      page: 2,
      pageSize: 10,
      filters: { workItemId: "work-item:501", status: "running" },
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/dashboard/jobs?page=2&pageSize=10&status=running&workItemId=work-item%3A501",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects ambiguous execution scopes before issuing a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = new HttpReviewControlAdapter({ fetch });

    await expect(
      adapter.listJobs({ filters: { workItemId: ["work-item:501", "work-item:502"] } }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe.each(["listWorkItems", "listJobs"] as const)("%s repository scope", (operation) => {
  const createWireItem = () => (operation === "listWorkItems" ? wireWorkItem("issue") : wireJob());

  it("sends one repository identity while preserving the workspace or execution filter", async () => {
    const repositoryId = "repository:powertoys";
    const item = { ...createWireItem(), repositoryId };
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ items: [item], total: 1 }),
    );
    const adapter = new HttpReviewControlAdapter({ fetch });

    const result = await adapter[operation]({
      page: 2,
      pageSize: 10,
      filters: {
        repositoryId,
        ...(operation === "listWorkItems"
          ? { kind: "issue" }
          : { workItemId: "item-pull_request-501" }),
      },
    });

    expect(fetch).toHaveBeenCalledOnce();
    const url = new URL(String(fetch.mock.calls[0]?.[0]), "https://review.example");
    expect(url.pathname).toBe(
      operation === "listWorkItems" ? "/api/v1/dashboard/work-items" : "/api/v1/dashboard/jobs",
    );
    expect(url.searchParams.getAll("repositoryId")).toEqual([repositoryId]);
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("pageSize")).toBe("10");
    expect(url.searchParams.get(operation === "listWorkItems" ? "kind" : "workItemId")).toBe(
      operation === "listWorkItems" ? "issue" : "item-pull_request-501",
    );
    expect(result.items[0]?.repositoryId).toBe(repositoryId);
  });

  it("rejects empty, invalid, or array scopes before requesting data", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = new HttpReviewControlAdapter({ fetch });
    const invalidScopes: Array<string | string[]> = [
      "",
      "microsoft/PowerToys",
      "repo-1\n",
      " repo-powertoys",
      "r".repeat(129),
      [],
      ["repo-powertoys"],
      ["repo-powertoys", "repo-terminal"],
    ];

    for (const repositoryId of invalidScopes) {
      await expect(adapter[operation]({ filters: { repositoryId } })).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a response containing any item from a different repository", async () => {
    const items = [
      createWireItem(),
      { ...createWireItem(), id: "foreign-item-501", repositoryId: "repo-terminal" },
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ items, total: items.length }),
    );
    const adapter = new HttpReviewControlAdapter({ fetch });

    await expect(
      adapter[operation]({ filters: { repositoryId: "repo-powertoys" } }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("permits mixed repositories when the operator selects all repositories", async () => {
    const items = [
      createWireItem(),
      { ...createWireItem(), id: "other-item-501", repositoryId: "repo-terminal" },
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ items, total: items.length }),
    );
    const adapter = new HttpReviewControlAdapter({ fetch });

    const result = await adapter[operation]();

    expect(result.items.map((item) => item.repositoryId)).toEqual([
      "repo-powertoys",
      "repo-terminal",
    ]);
    const url = new URL(String(fetch.mock.calls[0]?.[0]), "https://review.example");
    expect(url.searchParams.has("repositoryId")).toBe(false);
  });

  it("retains an unknown repository identity rather than falling back to a global request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ items: [], total: 0 }));
    const adapter = new HttpReviewControlAdapter({ fetch });

    const result = await adapter[operation]({ filters: { repositoryId: "repo-not-configured" } });

    expect(result).toEqual({ items: [], total: 0 });
    const url = new URL(String(fetch.mock.calls[0]?.[0]), "https://review.example");
    expect(url.searchParams.get("repositoryId")).toBe("repo-not-configured");
  });
});

describe("mock work item workspace isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const resolveMock = async <T>(pending: Promise<T>): Promise<T> => {
    await vi.runAllTimersAsync();
    return pending;
  };

  it.each(
    repositoryIds.flatMap((repositoryId) => workItemKinds.map((kind) => ({ repositoryId, kind }))),
  )(
    "paginates $kind within $repositoryId and reports the scoped total",
    async ({ repositoryId, kind }) => {
      const adapter = new MockReviewControlAdapter();
      const expected = workItems.filter(
        (item) => item.repositoryId === repositoryId && item.kind === kind,
      );
      expect(repositoryIds.length).toBeGreaterThan(1);
      expect(expected.length).toBeGreaterThan(0);
      expect(expected.length).toBeLessThan(workItems.length);

      for (let index = 0; index <= expected.length; index += 1) {
        const result = await resolveMock(
          adapter.listWorkItems({ page: index + 1, pageSize: 1, filters: { repositoryId, kind } }),
        );

        expect(result).toEqual({ items: expected.slice(index, index + 1), total: expected.length });
      }
    },
  );

  it.each(repositoryIds)(
    "paginates executions within %s and reports the scoped total",
    async (repositoryId) => {
      const adapter = new MockReviewControlAdapter();
      const expected = jobs.filter((job) => job.repositoryId === repositoryId);
      expect(expected.length).toBeGreaterThan(0);
      expect(expected.length).toBeLessThan(jobs.length);

      for (let index = 0; index <= expected.length; index += 1) {
        const result = await resolveMock(
          adapter.listJobs({ page: index + 1, pageSize: 1, filters: { repositoryId } }),
        );

        expect(result).toEqual({ items: expected.slice(index, index + 1), total: expected.length });
      }
    },
  );

  it.each(repositoryIds)(
    "combines %s and exact work item scope without crossing repositories",
    async (repositoryId) => {
      const adapter = new MockReviewControlAdapter();
      const existing = jobs.find((job) => job.repositoryId === repositoryId);
      const otherRepositoryId = repositoryIds.find((id) => id !== repositoryId);
      if (existing === undefined || otherRepositoryId === undefined) {
        throw new Error("Execution fixtures in two repositories are required for scope isolation.");
      }
      const expected = jobs.filter(
        (job) => job.repositoryId === repositoryId && job.workItemId === existing.workItemId,
      );

      const result = await resolveMock(
        adapter.listJobs({
          page: 1,
          pageSize: 1,
          filters: { repositoryId, workItemId: existing.workItemId },
        }),
      );

      expect(result).toEqual({ items: expected.slice(0, 1), total: expected.length });
      await expect(
        resolveMock(
          adapter.listJobs({
            filters: { repositoryId: otherRepositoryId, workItemId: existing.workItemId },
          }),
        ),
      ).resolves.toEqual({ items: [], total: 0 });
    },
  );

  it("does not replace an unknown repository with the global work item or execution list", async () => {
    const adapter = new MockReviewControlAdapter();
    const repositoryId = "repo-not-configured";
    expect(repositoryIds).not.toContain(repositoryId);

    for (const kind of workItemKinds) {
      await expect(
        resolveMock(adapter.listWorkItems({ filters: { repositoryId, kind } })),
      ).resolves.toEqual({ items: [], total: 0 });
    }
    await expect(resolveMock(adapter.listJobs({ filters: { repositoryId } }))).resolves.toEqual({
      items: [],
      total: 0,
    });
  });

  it("returns all repository records only when repository scope is omitted", async () => {
    const adapter = new MockReviewControlAdapter();

    await expect(resolveMock(adapter.listWorkItems({ pageSize: 200 }))).resolves.toEqual({
      items: workItems,
      total: workItems.length,
    });
    await expect(resolveMock(adapter.listJobs({ pageSize: 200 }))).resolves.toEqual({
      items: jobs,
      total: jobs.length,
    });
  });

  it.each(workItemKinds)("filters %s before pagination and reports its own total", async (kind) => {
    const adapter = new MockReviewControlAdapter();
    const expected = workItems.filter((item) => item.kind === kind);
    expect(expected.length).toBeGreaterThan(1);

    for (let index = 0; index <= expected.length; index += 1) {
      const result = await resolveMock(
        adapter.listWorkItems({ page: index + 1, pageSize: 1, filters: { kind } }),
      );

      expect(result.total).toBe(expected.length);
      expect(result.items).toEqual(expected.slice(index, index + 1));
    }
  });

  it.each([...new Set(jobs.map((job) => job.workItemId))])(
    "returns only executions linked to %s",
    async (workItemId) => {
      const adapter = new MockReviewControlAdapter();
      const expected = jobs.filter((job) => job.workItemId === workItemId);

      const result = await resolveMock(adapter.listJobs({ filters: { workItemId } }));

      expect(result).toEqual({ items: expected, total: expected.length });
    },
  );

  it("does not match an execution scope by identifier prefix", async () => {
    const adapter = new MockReviewControlAdapter();
    const existing = jobs[0];
    if (existing === undefined) {
      throw new Error("An execution fixture is required to test scope isolation.");
    }
    const workItemId = existing.workItemId.slice(0, -1);
    expect(jobs.some((job) => job.workItemId === workItemId)).toBe(false);

    await expect(resolveMock(adapter.listJobs({ filters: { workItemId } }))).resolves.toEqual({
      items: [],
      total: 0,
    });
  });

  it("combines work item scope and execution status before pagination", async () => {
    const adapter = new MockReviewControlAdapter();
    const existing = jobs.find((job) => job.status === "running");
    if (existing === undefined) {
      throw new Error("A running execution fixture is required to test combined filters.");
    }
    const expected = jobs.filter(
      (job) => job.workItemId === existing.workItemId && job.status === existing.status,
    );

    const result = await resolveMock(
      adapter.listJobs({
        page: 1,
        pageSize: 1,
        filters: { workItemId: existing.workItemId, status: existing.status },
      }),
    );

    expect(result).toEqual({ items: expected.slice(0, 1), total: expected.length });
    const cancelled = jobs.filter(
      (job) => job.workItemId === existing.workItemId && job.status === "cancelled",
    );
    await expect(
      resolveMock(
        adapter.listJobs({ filters: { workItemId: existing.workItemId, status: "cancelled" } }),
      ),
    ).resolves.toEqual({
      items: cancelled,
      total: cancelled.length,
    });
  });
});
