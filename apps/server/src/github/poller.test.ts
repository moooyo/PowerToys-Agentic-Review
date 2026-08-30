import type { NormalizedSchedulingEvent } from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  type GitHubIssueSnapshot,
  type GitHubPage,
  type GitHubPollingActiveProjection,
  type GitHubPollingPageContext,
  type GitHubPullRequestSnapshot,
  type GitHubRateLimitState,
  type GitHubReadClient,
  type GitHubSearchItem,
  type GitHubSearchRequest,
  type GitHubTimelineEvent,
  type GitHubTimelineReadRequest,
  type GitHubWorkItemReadRequest,
  reconcileGitHubPolling,
} from "../../dist/github/poller.js";
import { createPullRequestRevisionKey } from "../../dist/github/revision-key.js";

const observedAt = "2026-08-30T12:00:00.000Z";
const reviewer = { githubUserId: 100, login: "reviewer" };
const repositoryTarget = { githubRepositoryId: 1, fullName: "microsoft/PowerToys" };
const repository = {
  githubRepositoryId: 1,
  githubNodeId: "R_1",
  fullName: "microsoft/PowerToys",
  htmlUrl: "https://github.com/microsoft/PowerToys",
  defaultBranch: "main",
  isPrivate: false,
};
const author = {
  githubUserId: 200,
  githubNodeId: "U_200",
  login: "author",
  accountType: "user" as const,
};
const assigner = {
  githubUserId: 300,
  githubNodeId: "U_300",
  login: "assigner",
  accountType: "user" as const,
};
const reviewRequester = {
  githubUserId: 400,
  githubNodeId: "U_400",
  login: "review-requester",
  accountType: "user" as const,
};
const timelineTarget = {
  githubUserId: reviewer.githubUserId,
  githubNodeId: "U_100",
  login: reviewer.login,
  accountType: "user" as const,
};

const issue: GitHubIssueSnapshot = {
  kind: "issue",
  githubWorkItemId: 10,
  githubNodeId: "I_10",
  number: 10,
  title: "Issue title",
  body: "Issue body",
  state: "open",
  author,
  htmlUrl: "https://github.com/microsoft/PowerToys/issues/10",
  createdAt: "2026-08-29T01:00:00.000Z",
  updatedAt: "2026-08-30T01:00:00.000Z",
  closedAt: null,
};

const pullRequest: GitHubPullRequestSnapshot = {
  kind: "pull_request",
  githubWorkItemId: 20,
  githubNodeId: "PR_20",
  number: 20,
  title: "Pull request title",
  body: "Pull request body",
  state: "open",
  author,
  htmlUrl: "https://github.com/microsoft/PowerToys/pull/20",
  createdAt: "2026-08-29T02:00:00.000Z",
  updatedAt: "2026-08-30T02:00:00.000Z",
  closedAt: null,
  isDraft: false,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};

const assignedIssueSearchItem: GitHubSearchItem = {
  kind: "issue",
  githubWorkItemId: issue.githubWorkItemId,
  number: issue.number,
};
const assignedPullRequestSearchItem: GitHubSearchItem = {
  kind: "pull_request",
  githubWorkItemId: pullRequest.githubWorkItemId,
  number: pullRequest.number,
};
const assignedIssueEvent: GitHubTimelineEvent = {
  githubEventId: 1_001,
  action: "assigned",
  actor: assigner,
  target: timelineTarget,
  occurredAt: "2026-08-30T03:00:00.000Z",
};
const assignedPullRequestEvent: GitHubTimelineEvent = {
  githubEventId: 2_001,
  action: "assigned",
  actor: assigner,
  target: timelineTarget,
  occurredAt: "2026-08-30T04:00:00.000Z",
};
const reviewRequestedEvent: GitHubTimelineEvent = {
  githubEventId: 2_002,
  action: "review_requested",
  actor: reviewRequester,
  target: timelineTarget,
  occurredAt: "2026-08-30T05:00:00.000Z",
};

interface FakeClientOverrides {
  readonly search?: (request: GitHubSearchRequest) => Promise<GitHubPage<GitHubSearchItem>>;
  readonly timeline?: (
    request: GitHubTimelineReadRequest,
  ) => Promise<GitHubPage<GitHubTimelineEvent>>;
  readonly issue?: GitHubIssueSnapshot;
  readonly pullRequest?: GitHubPullRequestSnapshot;
}

function createClient(overrides: FakeClientOverrides = {}): GitHubReadClient & {
  getIssue: ReturnType<typeof vi.fn>;
  getPullRequest: ReturnType<typeof vi.fn>;
  listIssueTimelineEvents: ReturnType<typeof vi.fn>;
  searchIssuesAndPullRequests: ReturnType<typeof vi.fn>;
} {
  const search =
    overrides.search ??
    (async (request: GitHubSearchRequest): Promise<GitHubPage<GitHubSearchItem>> => ({
      items: request.query.includes("review-requested")
        ? [assignedPullRequestSearchItem]
        : [assignedIssueSearchItem, assignedPullRequestSearchItem],
      nextPage: null,
    }));
  const timeline =
    overrides.timeline ??
    (async (request: GitHubTimelineReadRequest): Promise<GitHubPage<GitHubTimelineEvent>> => ({
      items:
        request.number === issue.number
          ? [assignedIssueEvent]
          : [reviewRequestedEvent, assignedPullRequestEvent],
      nextPage: null,
    }));
  return {
    getRepository: vi.fn(async () => repository),
    searchIssuesAndPullRequests: vi.fn(search),
    getIssue: vi.fn(async (_request: GitHubWorkItemReadRequest) => overrides.issue ?? issue),
    getPullRequest: vi.fn(
      async (_request: GitHubWorkItemReadRequest) => overrides.pullRequest ?? pullRequest,
    ),
    listIssueTimelineEvents: vi.fn(timeline),
  };
}

async function reconcile(
  client: GitHubReadClient,
  events: NormalizedSchedulingEvent[],
  overrides: Partial<{
    maxSearchPages: number;
    maxTimelinePages: number;
    observeRateLimit: (
      state: GitHubRateLimitState,
      context: GitHubPollingPageContext,
      signal: AbortSignal | undefined,
    ) => void | Promise<void>;
    signal: AbortSignal;
    now: () => Date;
    previousActiveProjection: GitHubPollingActiveProjection | null;
    isPermanentlyUnavailableWorkItem: (error: unknown) => boolean;
  }> = {},
) {
  return reconcileGitHubPolling({
    client,
    repository: repositoryTarget,
    reviewer,
    ingest: (event) => {
      events.push(event);
    },
    now: () => new Date(observedAt),
    ...overrides,
  });
}

describe("reconcileGitHubPolling", () => {
  it("deduplicates search results while preserving independent active request kinds", async () => {
    const client = createClient();
    const events: NormalizedSchedulingEvent[] = [];
    const result = await reconcile(client, events);

    expect(client.searchIssuesAndPullRequests).toHaveBeenCalledTimes(2);
    expect(client.searchIssuesAndPullRequests).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        query: "repo:microsoft/PowerToys is:open assignee:reviewer",
        page: 1,
        perPage: 100,
      }),
    );
    expect(client.searchIssuesAndPullRequests).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        query: "repo:microsoft/PowerToys is:open is:pr review-requested:reviewer",
      }),
    );
    expect(client.getIssue).toHaveBeenCalledOnce();
    expect(client.getPullRequest).toHaveBeenCalledOnce();
    expect(client.listIssueTimelineEvents).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      uniqueWorkItemCount: 2,
      emittedEventCount: 4,
      searchPageCount: 2,
      timelinePageCount: 2,
      searchTruncated: false,
      timelineTruncatedWorkItemNumbers: [],
    });

    const pullRequestEvents = events.filter(
      (event) => event.workItem.githubWorkItemId === pullRequest.githubWorkItemId,
    );
    expect(pullRequestEvents).toHaveLength(3);
    expect(pullRequestEvents[0]).toMatchObject({
      action: "request_opened",
      requestKind: "assignment",
      actor: { githubUserId: assigner.githubUserId },
      target: { githubUserId: reviewer.githubUserId },
    });
    expect(pullRequestEvents[1]).toMatchObject({
      action: "request_opened",
      requestKind: "review_request",
      actor: { githubUserId: reviewRequester.githubUserId },
      target: { githubUserId: reviewer.githubUserId },
    });
    expect(pullRequestEvents[2]).toMatchObject({
      action: "revision_observed",
      requestKind: null,
      actor: null,
      target: null,
      revision: {
        kind: "pull_request",
        baseSha: pullRequest.baseSha,
        headSha: pullRequest.headSha,
        revisionKey: createPullRequestRevisionKey(pullRequest.baseSha, pullRequest.headSha),
      },
    });
  });

  it("replays timeline transitions chronologically and uses the latest active actor", async () => {
    const reassignedBy = { ...assigner, githubUserId: 301, login: "second-assigner" };
    const client = createClient({
      search: async (request) => ({
        items: request.query.includes("review-requested") ? [] : [assignedIssueSearchItem],
        nextPage: null,
      }),
      timeline: async () => ({
        items: [
          {
            ...assignedIssueEvent,
            githubEventId: 1_003,
            actor: reassignedBy,
            occurredAt: "2026-08-30T07:00:00.000Z",
          },
          {
            ...assignedIssueEvent,
            githubEventId: 1_002,
            action: "unassigned",
            occurredAt: "2026-08-30T06:00:00.000Z",
          },
          assignedIssueEvent,
        ],
        nextPage: null,
      }),
    });
    const events: NormalizedSchedulingEvent[] = [];
    await reconcile(client, events);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "request_opened",
      requestKind: "assignment",
      actor: { githubUserId: reassignedBy.githubUserId },
      occurredAt: "2026-08-30T07:00:00.000Z",
    });
  });

  it("observes a new pull request revision when the base advances with the same head", async () => {
    const search = async (request: GitHubSearchRequest): Promise<GitHubPage<GitHubSearchItem>> => ({
      items: request.query.includes("review-requested") ? [assignedPullRequestSearchItem] : [],
      nextPage: null,
    });
    const firstEvents: NormalizedSchedulingEvent[] = [];
    const first = await reconcile(createClient({ search }), firstEvents);
    const advancedBase = "c".repeat(40);
    const secondEvents: NormalizedSchedulingEvent[] = [];
    await reconcile(
      createClient({
        search,
        pullRequest: { ...pullRequest, baseSha: advancedBase },
      }),
      secondEvents,
      { previousActiveProjection: first.nextActiveProjection },
    );

    const firstRevision = firstEvents.find((event) => event.action === "revision_observed");
    expect(secondEvents).toHaveLength(1);
    expect(secondEvents[0]).toMatchObject({
      action: "revision_observed",
      revision: {
        baseSha: advancedBase,
        headSha: pullRequest.headSha,
        revisionKey: createPullRequestRevisionKey(advancedBase, pullRequest.headSha),
      },
    });
    expect(secondEvents[0]?.sourceEventId).not.toBe(firstRevision?.sourceEventId);
  });

  it("observes edited issue content while its assignment remains active", async () => {
    const search = async (request: GitHubSearchRequest): Promise<GitHubPage<GitHubSearchItem>> => ({
      items: request.query.includes("review-requested") ? [] : [assignedIssueSearchItem],
      nextPage: null,
    });
    const initial = await reconcile(createClient({ search }), []);
    const editedAt = "2026-08-30T08:00:00.000Z";
    const editedIssue: GitHubIssueSnapshot = {
      ...issue,
      title: "Edited issue title",
      body: "Edited issue body",
      updatedAt: editedAt,
    };
    const events: NormalizedSchedulingEvent[] = [];
    const result = await reconcile(createClient({ search, issue: editedIssue }), events, {
      previousActiveProjection: initial.nextActiveProjection,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "revision_observed",
      requestKind: null,
      actor: null,
      target: null,
      occurredAt: editedAt,
      workItem: {
        kind: "issue",
        title: editedIssue.title,
        body: editedIssue.body,
      },
      revision: {
        kind: "issue",
        sourceUpdatedAt: editedAt,
      },
    });
    const editedRevision = events[0]?.revision;
    if (editedRevision?.kind !== "issue") {
      throw new Error("Expected an issue revision observation.");
    }
    expect(editedRevision.revisionKey).toBe(editedRevision.contentDigest);
    expect(result.nextActiveProjection.workItems[0]?.revision.revisionKey).toBe(
      editedRevision.revisionKey,
    );

    const differentlyEditedEvents: NormalizedSchedulingEvent[] = [];
    await reconcile(
      createClient({ search, issue: { ...editedIssue, body: "Different edited body" } }),
      differentlyEditedEvents,
      { previousActiveProjection: initial.nextActiveProjection },
    );
    expect(differentlyEditedEvents[0]?.sourceEventId).not.toBe(events[0]?.sourceEventId);
  });

  it("keeps an explicitly unknown timeline actor null", async () => {
    const client = createClient({
      search: async (request) => ({
        items: request.query.includes("review-requested") ? [] : [assignedIssueSearchItem],
        nextPage: null,
      }),
      timeline: async () => ({
        items: [{ ...assignedIssueEvent, actor: null }],
        nextPage: null,
      }),
    });
    const events: NormalizedSchedulingEvent[] = [];
    await reconcile(client, events);

    expect(events[0]).toMatchObject({
      actor: null,
      target: { githubUserId: reviewer.githubUserId },
      author: { githubUserId: author.githubUserId },
    });
  });

  it("does not trust an older actor when timeline pagination is truncated", async () => {
    const client = createClient({
      search: async (request) => ({
        items: request.query.includes("review-requested") ? [] : [assignedIssueSearchItem],
        nextPage: null,
      }),
      timeline: async () => ({ items: [assignedIssueEvent], nextPage: 2 }),
    });
    const events: NormalizedSchedulingEvent[] = [];
    const result = await reconcile(client, events, { maxTimelinePages: 1 });

    expect(result.timelineTruncatedWorkItemNumbers).toEqual([issue.number]);
    expect(events[0]).toMatchObject({
      actor: null,
      target: { githubUserId: reviewer.githubUserId },
      occurredAt: issue.updatedAt,
    });
  });

  it("keeps synthetic event identities stable across observation times", async () => {
    const client = createClient({
      search: async (request) => ({
        items: request.query.includes("review-requested") ? [] : [assignedIssueSearchItem],
        nextPage: null,
      }),
      timeline: async () => ({ items: [], nextPage: null }),
    });
    const first: NormalizedSchedulingEvent[] = [];
    const second: NormalizedSchedulingEvent[] = [];
    await reconcile(client, first);
    await reconcile(client, second, { now: () => new Date("2026-08-31T12:00:00.000Z") });

    expect(first[0]?.eventId).toBe(second[0]?.eventId);
    expect(first[0]?.sourceEventId).toBe(second[0]?.sourceEventId);
    expect(first[0]?.observedAt).not.toBe(second[0]?.observedAt);
    expect(first[0]?.actor).toBeNull();
  });

  it("honors page limits and exposes rate-limit metadata", async () => {
    const pageCalls: number[] = [];
    const rateLimitObservations: Array<{
      state: GitHubRateLimitState;
      context: GitHubPollingPageContext;
    }> = [];
    const rateLimit = {
      resource: "search",
      remaining: 4,
      resetAt: "2026-08-30T12:05:00.000Z",
    } satisfies GitHubRateLimitState;
    const client = createClient({
      search: async (request) => {
        if (request.query.includes("review-requested")) {
          return { items: [], nextPage: null };
        }
        pageCalls.push(request.page);
        return {
          items: request.page === 1 ? [assignedIssueSearchItem] : [],
          nextPage: request.page + 1,
          rateLimit,
        };
      },
    });
    const events: NormalizedSchedulingEvent[] = [];
    const result = await reconcile(client, events, {
      maxSearchPages: 2,
      observeRateLimit: async (state, context) => {
        rateLimitObservations.push({ state, context });
      },
    });

    expect(pageCalls).toEqual([1, 2]);
    expect(result.searchTruncated).toBe(true);
    expect(rateLimitObservations).toEqual([
      {
        state: rateLimit,
        context: { operation: "assigned_search", page: 1, workItemNumber: null },
      },
      {
        state: rateLimit,
        context: { operation: "assigned_search", page: 2, workItemNumber: null },
      },
    ]);
  });

  it("closes requests that disappear from a complete search using persisted active state", async () => {
    const initiallyAssigned = createClient({
      search: async (request) => ({
        items: request.query.includes("review-requested") ? [] : [assignedIssueSearchItem],
        nextPage: null,
      }),
    });
    const initialEvents: NormalizedSchedulingEvent[] = [];
    const initial = await reconcile(initiallyAssigned, initialEvents);
    const noLongerAssigned = createClient({
      search: async () => ({ items: [], nextPage: null }),
    });
    const closeEvents: NormalizedSchedulingEvent[] = [];
    const closed = await reconcile(noLongerAssigned, closeEvents, {
      previousActiveProjection: initial.nextActiveProjection,
    });

    expect(closeEvents).toHaveLength(1);
    expect(closeEvents[0]).toMatchObject({
      source: "reconciliation",
      action: "request_closed",
      requestKind: "assignment",
      closeReason: "assignment_removed",
      actor: null,
      target: { githubUserId: reviewer.githubUserId },
    });
    expect(noLongerAssigned.listIssueTimelineEvents).not.toHaveBeenCalled();
    expect(closed.nextActiveProjection.workItems).toEqual([]);

    const retriedEvents: NormalizedSchedulingEvent[] = [];
    await reconcile(noLongerAssigned, retriedEvents, {
      now: () => new Date("2026-08-31T12:00:00.000Z"),
      previousActiveProjection: initial.nextActiveProjection,
    });
    expect(retriedEvents[0]?.sourceEventId).toBe(closeEvents[0]?.sourceEventId);
  });

  it("emits a work item close when a previously active item left the open search", async () => {
    const initiallyAssigned = createClient({
      search: async (request) => ({
        items: request.query.includes("review-requested") ? [] : [assignedIssueSearchItem],
        nextPage: null,
      }),
    });
    const initial = await reconcile(initiallyAssigned, []);
    const closedAt = "2026-08-30T10:00:00.000Z";
    const closedIssue: GitHubIssueSnapshot = {
      ...issue,
      state: "closed",
      updatedAt: closedAt,
      closedAt,
    };
    const client = createClient({
      search: async () => ({ items: [], nextPage: null }),
      issue: closedIssue,
    });
    const events: NormalizedSchedulingEvent[] = [];
    const result = await reconcile(client, events, {
      previousActiveProjection: initial.nextActiveProjection,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "reconciliation",
      action: "work_item_closed",
      closeReason: "work_item_closed",
      occurredAt: closedAt,
      actor: null,
      target: null,
      workItem: { state: "closed" },
    });
    expect(result.nextActiveProjection.workItems).toEqual([]);
  });

  it("preserves unseen prior assignments while their search result is truncated", async () => {
    const initiallyAssigned = createClient({
      search: async (request) => ({
        items: request.query.includes("review-requested") ? [] : [assignedIssueSearchItem],
        nextPage: null,
      }),
    });
    const initial = await reconcile(initiallyAssigned, []);
    const truncated = createClient({
      search: async (request) =>
        request.query.includes("review-requested")
          ? { items: [], nextPage: null }
          : { items: [], nextPage: null, incomplete: true },
    });
    const events: NormalizedSchedulingEvent[] = [];
    const result = await reconcile(truncated, events, {
      maxSearchPages: 1,
      previousActiveProjection: initial.nextActiveProjection,
    });

    expect(events).toEqual([]);
    expect(result.searchTruncated).toBe(true);
    expect(result.nextActiveProjection.workItems[0]?.activeRequests).toEqual(
      initial.nextActiveProjection.workItems[0]?.activeRequests,
    );
  });

  it("preserves one unavailable historical item without blocking the repository", async () => {
    const initial = await reconcile(createClient(), []);
    const nextClient = createClient({
      search: async (request) => ({
        items: request.query.includes("review-requested")
          ? [assignedPullRequestSearchItem]
          : [assignedPullRequestSearchItem],
        nextPage: null,
      }),
    });
    nextClient.getIssue.mockRejectedValue(Object.assign(new Error("Gone"), { status: 410 }));

    const result = await reconcile(nextClient, [], {
      previousActiveProjection: initial.nextActiveProjection,
      isPermanentlyUnavailableWorkItem: (error) =>
        typeof error === "object" && error !== null && "status" in error,
    });

    expect(result.unavailableWorkItemNumbers).toEqual([issue.number]);
    expect(result.nextActiveProjection.workItems).toHaveLength(2);
    expect(nextClient.getPullRequest).toHaveBeenCalledOnce();
  });

  it("propagates AbortSignal and stops before API access", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop polling"));
    const client = createClient();
    const events: NormalizedSchedulingEvent[] = [];

    await expect(reconcile(client, events, { signal: controller.signal })).rejects.toThrow(
      "stop polling",
    );
    expect(client.searchIssuesAndPullRequests).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});
