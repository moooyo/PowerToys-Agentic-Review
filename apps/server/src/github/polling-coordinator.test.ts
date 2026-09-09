import type { NormalizedSchedulingEvent } from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";

import type {
  GitHubIssueSnapshot,
  GitHubPollingActiveProjection,
  GitHubPollingProjectionKey,
  GitHubPollingStateSink,
  GitHubPollingStateSource,
  GitHubReadClient,
  GitHubReadRequestBase,
} from "../../dist/github/poller.js";
import {
  GitHubPollingCoordinator,
  type GitHubPollingRuntimeTarget,
} from "../../dist/github/polling-coordinator.js";

const repositoryTarget = { githubRepositoryId: 1, fullName: "microsoft/PowerToys" };
const reviewer = { githubUserId: 100, login: "reviewer" };
const runtimeTargets: readonly GitHubPollingRuntimeTarget[] = [
  {
    repository: { githubRepositoryId: 2, fullName: "example/first" },
    reviewer: { githubUserId: 300, login: "first-reviewer" },
  },
  {
    repository: { githubRepositoryId: 3, fullName: "example/second" },
    reviewer: { githubUserId: 400, login: "second-reviewer" },
  },
];
const author = { githubUserId: 200, login: "author", accountType: "user" as const };
const issue: GitHubIssueSnapshot = {
  kind: "issue",
  githubWorkItemId: 10,
  githubNodeId: "I_10",
  number: 10,
  title: "Issue title",
  body: null,
  state: "open",
  author,
  htmlUrl: "https://github.com/microsoft/PowerToys/issues/10",
  createdAt: "2026-08-29T01:00:00.000Z",
  updatedAt: "2026-08-30T01:00:00.000Z",
  closedAt: null,
};

function createClient(): GitHubReadClient & {
  getRepository: ReturnType<typeof vi.fn>;
  searchIssuesAndPullRequests: ReturnType<typeof vi.fn>;
} {
  return {
    getRepository: vi.fn(async () => ({
      githubRepositoryId: 1,
      githubNodeId: "R_1",
      fullName: "microsoft/PowerToys",
      htmlUrl: "https://github.com/microsoft/PowerToys",
      defaultBranch: "main",
      isPrivate: false,
    })),
    searchIssuesAndPullRequests: vi.fn(async (request) => ({
      items: request.query.includes("review-requested")
        ? []
        : [{ kind: "issue" as const, githubWorkItemId: 10, number: 10 }],
      nextPage: null,
    })),
    getIssue: vi.fn(async () => issue),
    getPullRequest: vi.fn(async () => {
      throw new Error("Unexpected pull request read.");
    }),
    listIssueTimelineEvents: vi.fn(async () => ({
      items: [
        {
          githubEventId: 1_001,
          action: "assigned" as const,
          actor: { githubUserId: 100, login: "reviewer", accountType: "user" as const },
          target: { githubUserId: 100, login: "reviewer", accountType: "user" as const },
          occurredAt: "2026-08-30T01:00:00.000Z",
        },
      ],
      nextPage: null,
    })),
  };
}

function createState(): GitHubPollingStateSource &
  GitHubPollingStateSink & {
    readActiveProjection: ReturnType<typeof vi.fn>;
    writeActiveProjection: ReturnType<typeof vi.fn>;
  } {
  let projection: GitHubPollingActiveProjection | null = null;
  return {
    readActiveProjection: vi.fn(
      async (_key: GitHubPollingProjectionKey, _signal: AbortSignal | undefined) => projection,
    ),
    writeActiveProjection: vi.fn(
      async (
        _key: GitHubPollingProjectionKey,
        next: GitHubPollingActiveProjection,
        _signal: AbortSignal | undefined,
      ) => {
        projection = next;
      },
    ),
  };
}

function createRuntimeClient(targets: readonly GitHubPollingRuntimeTarget[]) {
  const client = createClient();
  client.getRepository.mockImplementation(async (request: GitHubReadRequestBase) => {
    const target = targets.find(
      ({ repository }) => repository.fullName === request.repositoryFullName,
    );
    if (target === undefined) {
      throw new Error(`Unexpected repository read: ${request.repositoryFullName}`);
    }
    return {
      ...target.repository,
      githubNodeId: `R_${target.repository.githubRepositoryId}`,
      htmlUrl: `https://github.com/${target.repository.fullName}`,
      defaultBranch: "main",
      isPrivate: false,
    };
  });
  client.searchIssuesAndPullRequests.mockResolvedValue({ items: [], nextPage: null });
  return client;
}

describe("GitHubPollingCoordinator", () => {
  it("coalesces concurrent polls and commits events with their projection once", async () => {
    const client = createClient();
    const state = createState();
    const calls: string[] = [];
    const events: NormalizedSchedulingEvent[] = [];
    const coordinator = new GitHubPollingCoordinator({
      client,
      repositories: [repositoryTarget],
      reviewer,
      intervalMs: 60_000,
      stateSource: state,
      commitReconciliation: async (key, batch, projection, signal) => {
        calls.push("commit");
        events.push(...batch);
        await state.writeActiveProjection(key, projection, signal);
      },
      signal: new AbortController().signal,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });

    const first = coordinator.pollOnce();
    const second = coordinator.pollOnce();
    expect(second).toBe(first);
    const outcomes = await first;

    expect(outcomes).toMatchObject([{ status: "fulfilled", repository: repositoryTarget }]);
    expect(client.getRepository).toHaveBeenCalledOnce();
    expect(client.searchIssuesAndPullRequests.mock.calls.map(([request]) => request.query)).toEqual(
      [
        "repo:microsoft/PowerToys is:open assignee:reviewer",
        "repo:microsoft/PowerToys is:open is:pr review-requested:reviewer",
      ],
    );
    expect(events.map((event) => event.action)).toEqual(["request_opened", "revision_observed"]);
    expect(calls).toEqual(["commit"]);
    expect(state.writeActiveProjection).toHaveBeenCalledOnce();
  });

  it("uses each runtime target's reviewer for search and projection persistence", async () => {
    const client = createRuntimeClient(runtimeTargets);
    const state = createState();
    const commitReconciliation = vi.fn();
    const signal = new AbortController().signal;
    const coordinator = new GitHubPollingCoordinator({
      client,
      repositories: [repositoryTarget],
      reviewer,
      resolveTargets: async () => runtimeTargets,
      intervalMs: 60_000,
      stateSource: state,
      commitReconciliation,
      signal,
    });

    const outcomes = await coordinator.pollOnce();

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(client.searchIssuesAndPullRequests.mock.calls.map(([request]) => request.query)).toEqual(
      [
        "repo:example/first is:open assignee:first-reviewer",
        "repo:example/first is:open is:pr review-requested:first-reviewer",
        "repo:example/second is:open assignee:second-reviewer",
        "repo:example/second is:open is:pr review-requested:second-reviewer",
      ],
    );
    runtimeTargets.forEach((target, index) => {
      const key = {
        githubRepositoryId: target.repository.githubRepositoryId,
        repositoryFullName: target.repository.fullName,
        reviewerGithubUserId: target.reviewer.githubUserId,
      };
      expect(state.readActiveProjection).toHaveBeenNthCalledWith(index + 1, key, signal);
      expect(commitReconciliation).toHaveBeenNthCalledWith(
        index + 1,
        key,
        [],
        expect.objectContaining({ ...key, reviewerLogin: target.reviewer.login }),
        signal,
      );
    });
  });

  it("supports resolver-only configuration without legacy repository or reviewer placeholders", async () => {
    const client = createRuntimeClient(runtimeTargets);
    const state = createState();
    const coordinator = new GitHubPollingCoordinator({
      client,
      resolveTargets: () => runtimeTargets,
      intervalMs: 60_000,
      stateSource: state,
      commitReconciliation: vi.fn(),
      signal: new AbortController().signal,
    });

    const outcomes = await coordinator.pollOnce();

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(state.readActiveProjection.mock.calls.map(([key]) => key.reviewerGithubUserId)).toEqual([
      300, 400,
    ]);
    expect(client.searchIssuesAndPullRequests.mock.calls.map(([request]) => request.query)).toEqual(
      [
        "repo:example/first is:open assignee:first-reviewer",
        "repo:example/first is:open is:pr review-requested:first-reviewer",
        "repo:example/second is:open assignee:second-reviewer",
        "repo:example/second is:open is:pr review-requested:second-reviewer",
      ],
    );
  });

  it("allows resolver-only first startup before any repository is configured", async () => {
    const client = createClient();
    const state = createState();
    const commitReconciliation = vi.fn();
    const coordinator = new GitHubPollingCoordinator({
      client,
      resolveTargets: async () => [],
      intervalMs: 60_000,
      stateSource: state,
      commitReconciliation,
      signal: new AbortController().signal,
    });

    await expect(coordinator.pollOnce()).resolves.toEqual([]);
    expect(client.getRepository).not.toHaveBeenCalled();
    expect(state.readActiveProjection).not.toHaveBeenCalled();
    expect(commitReconciliation).not.toHaveBeenCalled();
  });

  it("refreshes the authoritative targets each cycle and accepts an empty target set", async () => {
    const client = createRuntimeClient(runtimeTargets);
    const state = createState();
    const commitReconciliation = vi.fn();
    let targets = runtimeTargets.slice(0, 1);
    const resolveTargets = vi.fn(() => targets);
    const coordinator = new GitHubPollingCoordinator({
      client,
      repositories: [repositoryTarget],
      reviewer,
      resolveTargets,
      intervalMs: 60_000,
      stateSource: state,
      commitReconciliation,
      signal: new AbortController().signal,
    });

    await coordinator.pollOnce();
    targets = runtimeTargets.slice(1);
    await coordinator.pollOnce();
    targets = [];
    await expect(coordinator.pollOnce()).resolves.toEqual([]);

    expect(resolveTargets).toHaveBeenCalledTimes(3);
    expect(client.getRepository.mock.calls.map(([request]) => request.repositoryFullName)).toEqual([
      "example/first",
      "example/second",
    ]);
    expect(state.readActiveProjection).toHaveBeenCalledTimes(2);
    expect(commitReconciliation).toHaveBeenCalledTimes(2);
  });

  it("reconciles current and historical reviewers independently for the same repository", async () => {
    const currentReviewer = { githubUserId: 300, login: "current-reviewer" };
    const historicalReviewer = { githubUserId: 400, login: "historical-reviewer" };
    const targets = [
      { repository: repositoryTarget, reviewer: currentReviewer },
      { repository: repositoryTarget, reviewer: historicalReviewer },
    ];
    const client = createRuntimeClient(targets);
    const state = createState();
    const commitReconciliation = vi.fn();
    const coordinator = new GitHubPollingCoordinator({
      client,
      repositories: [],
      reviewer,
      resolveTargets: () => targets,
      intervalMs: 60_000,
      stateSource: state,
      commitReconciliation,
      signal: new AbortController().signal,
    });

    const outcomes = await coordinator.pollOnce();

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(state.readActiveProjection.mock.calls.map(([key]) => key)).toEqual([
      {
        githubRepositoryId: repositoryTarget.githubRepositoryId,
        repositoryFullName: repositoryTarget.fullName,
        reviewerGithubUserId: currentReviewer.githubUserId,
      },
      {
        githubRepositoryId: repositoryTarget.githubRepositoryId,
        repositoryFullName: repositoryTarget.fullName,
        reviewerGithubUserId: historicalReviewer.githubUserId,
      },
    ]);
    expect(commitReconciliation.mock.calls.map(([key]) => key)).toEqual(
      state.readActiveProjection.mock.calls.map(([key]) => key),
    );
    expect(client.searchIssuesAndPullRequests.mock.calls.map(([request]) => request.query)).toEqual(
      [
        "repo:microsoft/PowerToys is:open assignee:current-reviewer",
        "repo:microsoft/PowerToys is:open is:pr review-requested:current-reviewer",
        "repo:microsoft/PowerToys is:open assignee:historical-reviewer",
        "repo:microsoft/PowerToys is:open is:pr review-requested:historical-reviewer",
      ],
    );
  });

  it("switches the projection namespace when a repository's reviewer changes", async () => {
    const client = createRuntimeClient(runtimeTargets);
    const state = createState();
    const commitReconciliation = vi.fn();
    const firstTarget = runtimeTargets[0];
    if (firstTarget === undefined) {
      throw new Error("Missing runtime target fixture.");
    }
    let target = firstTarget;
    const coordinator = new GitHubPollingCoordinator({
      client,
      repositories: [],
      reviewer,
      resolveTargets: () => [target],
      intervalMs: 60_000,
      stateSource: state,
      commitReconciliation,
      signal: new AbortController().signal,
    });

    await coordinator.pollOnce();
    target = { ...firstTarget, reviewer: { githubUserId: 500, login: "replacement-reviewer" } };
    await coordinator.pollOnce();

    expect(state.readActiveProjection.mock.calls.map(([key]) => key.reviewerGithubUserId)).toEqual([
      300, 500,
    ]);
    expect(commitReconciliation.mock.calls.map(([key]) => key.reviewerGithubUserId)).toEqual([
      300, 500,
    ]);
    expect(client.searchIssuesAndPullRequests.mock.calls.map(([request]) => request.query)).toEqual(
      [
        "repo:example/first is:open assignee:first-reviewer",
        "repo:example/first is:open is:pr review-requested:first-reviewer",
        "repo:example/first is:open assignee:replacement-reviewer",
        "repo:example/first is:open is:pr review-requested:replacement-reviewer",
      ],
    );
  });

  it("coalesces concurrent calls while runtime targets are still resolving", async () => {
    const client = createRuntimeClient(runtimeTargets);
    const state = createState();
    const pendingTargets = Promise.withResolvers<readonly GitHubPollingRuntimeTarget[]>();
    const resolveTargets = vi.fn(() => pendingTargets.promise);
    const coordinator = new GitHubPollingCoordinator({
      client,
      repositories: [],
      reviewer,
      resolveTargets,
      intervalMs: 60_000,
      stateSource: state,
      commitReconciliation: vi.fn(),
      signal: new AbortController().signal,
    });

    const first = coordinator.pollOnce();
    const second = coordinator.pollOnce();
    expect(second).toBe(first);
    expect(resolveTargets).toHaveBeenCalledOnce();
    expect(state.readActiveProjection).not.toHaveBeenCalled();
    pendingTargets.resolve(runtimeTargets);
    await first;

    expect(client.getRepository).toHaveBeenCalledTimes(2);
  });

  it.each(["synchronous", "asynchronous"])(
    "fails closed after a %s resolver error and allows a later cycle to recover",
    async (mode) => {
      const client = createRuntimeClient(runtimeTargets);
      const state = createState();
      const commitReconciliation = vi.fn();
      const resolverError = new Error("Repository configuration is unavailable.");
      let shouldFail = true;
      const resolveTargets = vi.fn(() => {
        if (!shouldFail) {
          return runtimeTargets;
        }
        if (mode === "synchronous") {
          throw resolverError;
        }
        return Promise.reject(resolverError);
      });
      const coordinator = new GitHubPollingCoordinator({
        client,
        repositories: [repositoryTarget],
        reviewer,
        resolveTargets,
        intervalMs: 60_000,
        stateSource: state,
        commitReconciliation,
        signal: new AbortController().signal,
      });

      await expect(coordinator.pollOnce()).rejects.toBe(resolverError);
      expect(client.getRepository).not.toHaveBeenCalled();
      expect(state.readActiveProjection).not.toHaveBeenCalled();
      expect(commitReconciliation).not.toHaveBeenCalled();

      shouldFail = false;
      await expect(coordinator.pollOnce()).resolves.toHaveLength(2);
      expect(resolveTargets).toHaveBeenCalledTimes(2);
      expect(client.getRepository).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    {
      name: "nonpositive repository IDs",
      target: { repository: { ...repositoryTarget, githubRepositoryId: 0 }, reviewer },
    },
    {
      name: "unsafe repository IDs",
      target: {
        repository: { ...repositoryTarget, githubRepositoryId: Number.MAX_SAFE_INTEGER + 1 },
        reviewer,
      },
    },
    {
      name: "invalid repository names",
      target: { repository: { ...repositoryTarget, fullName: "owner/name is:open" }, reviewer },
    },
    {
      name: "nonpositive reviewer IDs",
      target: { repository: repositoryTarget, reviewer: { ...reviewer, githubUserId: 0 } },
    },
    {
      name: "fractional reviewer IDs",
      target: { repository: repositoryTarget, reviewer: { ...reviewer, githubUserId: 1.5 } },
    },
    {
      name: "empty reviewer logins",
      target: { repository: repositoryTarget, reviewer: { ...reviewer, login: "" } },
    },
    {
      name: "invalid reviewer logins",
      target: { repository: repositoryTarget, reviewer: { ...reviewer, login: "user is:open" } },
    },
    {
      name: "repository IDs mapped to different names",
      target: { repository: { ...repositoryTarget, githubRepositoryId: 2 }, reviewer },
    },
    {
      name: "case-insensitive repository names mapped to different IDs",
      target: { repository: { ...repositoryTarget, fullName: "Example/FIRST" }, reviewer },
    },
    {
      name: "duplicate repository and reviewer pairs",
      target: {
        repository: { githubRepositoryId: 2, fullName: "example/first" },
        reviewer: { githubUserId: 300, login: "first-reviewer" },
      },
    },
  ])("rejects $name before polling any runtime target", async ({ target }) => {
    const client = createRuntimeClient(runtimeTargets);
    const state = createState();
    const commitReconciliation = vi.fn();
    const coordinator = new GitHubPollingCoordinator({
      client,
      repositories: [repositoryTarget],
      reviewer,
      resolveTargets: () => [...runtimeTargets.slice(0, 1), target],
      intervalMs: 60_000,
      stateSource: state,
      commitReconciliation,
      signal: new AbortController().signal,
    });

    await expect(coordinator.pollOnce()).rejects.toThrow(TypeError);
    expect(client.getRepository).not.toHaveBeenCalled();
    expect(state.readActiveProjection).not.toHaveBeenCalled();
    expect(commitReconciliation).not.toHaveBeenCalled();
  });

  it("retains constructor validation for the static configuration", () => {
    const options = {
      client: createClient(),
      repositories: [repositoryTarget],
      reviewer,
      intervalMs: 60_000,
      stateSource: createState(),
      commitReconciliation: vi.fn(),
      signal: new AbortController().signal,
    };

    expect(() => new GitHubPollingCoordinator({ ...options, repositories: [] })).toThrow(
      "At least one GitHub polling repository must be configured.",
    );
    expect(
      () =>
        new GitHubPollingCoordinator({
          ...options,
          repositories: [repositoryTarget, { ...repositoryTarget, fullName: "example/other" }],
          resolveTargets: () => [],
        }),
    ).toThrow("GitHub polling repositories must be unique by ID and full name.");
    expect(
      () =>
        new GitHubPollingCoordinator({ ...options, reviewer: { ...reviewer, githubUserId: 0 } }),
    ).toThrow("The GitHub polling reviewer must have a positive numeric ID.");
  });

  it("rejects construction without any target source", () => {
    expect(
      () =>
        new GitHubPollingCoordinator({
          client: createClient(),
          intervalMs: 60_000,
          stateSource: createState(),
          commitReconciliation: vi.fn(),
          signal: new AbortController().signal,
        }),
    ).toThrow("Configure resolveTargets or both repositories and reviewer.");
  });

  it.each([false, true])(
    "rejects partial static configuration when a resolver is present: %s",
    (withResolver) => {
      const options = {
        client: createClient(),
        intervalMs: 60_000,
        stateSource: createState(),
        commitReconciliation: vi.fn(),
        signal: new AbortController().signal,
        ...(withResolver ? { resolveTargets: () => [] } : {}),
      };

      expect(
        () => new GitHubPollingCoordinator({ ...options, repositories: [repositoryTarget] }),
      ).toThrow("Static repositories and reviewer must be configured together.");
      expect(() => new GitHubPollingCoordinator({ ...options, reviewer })).toThrow(
        "Static repositories and reviewer must be configured together.",
      );
    },
  );

  it("reports a runtime target's reviewer in repository failure context", async () => {
    const client = createRuntimeClient(runtimeTargets);
    const failure = new Error("GitHub request failed.");
    client.getRepository.mockRejectedValueOnce(failure);
    const observeError = vi.fn();
    const coordinator = new GitHubPollingCoordinator({
      client,
      repositories: [repositoryTarget],
      reviewer,
      resolveTargets: () => runtimeTargets,
      intervalMs: 60_000,
      stateSource: createState(),
      commitReconciliation: vi.fn(),
      observeError,
      signal: new AbortController().signal,
    });

    const outcomes = await coordinator.pollOnce();

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "fulfilled"]);
    expect(observeError).toHaveBeenCalledExactlyOnceWith(failure, runtimeTargets[0]);
  });

  it("reports the runtime reviewer for unavailable historical work items", async () => {
    const client = createClient();
    const state = createState();
    const runtimeReviewer = { githubUserId: 500, login: "replacement-reviewer" };
    const target = { repository: repositoryTarget, reviewer: runtimeReviewer };
    const observeUnavailableWorkItems = vi.fn();
    const coordinator = new GitHubPollingCoordinator({
      client,
      repositories: [],
      reviewer,
      resolveTargets: () => [target],
      intervalMs: 60_000,
      stateSource: state,
      commitReconciliation: (key, _events, projection, signal) =>
        state.writeActiveProjection(key, projection, signal),
      observeUnavailableWorkItems,
      isPermanentlyUnavailableWorkItem: () => true,
      signal: new AbortController().signal,
    });
    vi.mocked(client.listIssueTimelineEvents).mockResolvedValue({
      items: [
        {
          githubEventId: 1_001,
          action: "assigned",
          actor: { ...runtimeReviewer, accountType: "user" },
          target: { ...runtimeReviewer, accountType: "user" },
          occurredAt: "2026-08-30T01:00:00.000Z",
        },
      ],
      nextPage: null,
    });
    await coordinator.pollOnce();
    client.searchIssuesAndPullRequests.mockResolvedValue({ items: [], nextPage: null });
    vi.mocked(client.getIssue).mockRejectedValue(new Error("Work item is no longer accessible."));

    const outcomes = await coordinator.pollOnce();

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled"]);
    expect(observeUnavailableWorkItems).toHaveBeenCalledExactlyOnceWith([issue.number], target);
  });

  it("does not resolve targets after shutdown", async () => {
    const controller = new AbortController();
    const shutdownError = new Error("shutdown");
    controller.abort(shutdownError);
    const resolveTargets = vi.fn(() => []);
    const coordinator = new GitHubPollingCoordinator({
      client: createClient(),
      repositories: [],
      reviewer,
      resolveTargets,
      intervalMs: 60_000,
      stateSource: createState(),
      commitReconciliation: vi.fn(),
      signal: controller.signal,
    });

    await expect(coordinator.pollOnce()).rejects.toBe(shutdownError);
    expect(resolveTargets).not.toHaveBeenCalled();
  });

  it.each([
    { name: "empty", targets: [] },
    { name: "nonempty", targets: runtimeTargets },
  ])("honors shutdown while $name targets are resolving", async ({ targets }) => {
    const controller = new AbortController();
    const client = createRuntimeClient(runtimeTargets);
    const state = createState();
    const commitReconciliation = vi.fn();
    const pendingTargets = Promise.withResolvers<readonly GitHubPollingRuntimeTarget[]>();
    const shutdownError = new Error("shutdown");
    const coordinator = new GitHubPollingCoordinator({
      client,
      repositories: [],
      reviewer,
      resolveTargets: () => pendingTargets.promise,
      intervalMs: 60_000,
      stateSource: state,
      commitReconciliation,
      signal: controller.signal,
    });

    const cycle = coordinator.pollOnce();
    controller.abort(shutdownError);
    pendingTargets.resolve(targets);

    await expect(cycle).rejects.toBe(shutdownError);
    expect(client.getRepository).not.toHaveBeenCalled();
    expect(state.readActiveProjection).not.toHaveBeenCalled();
    expect(commitReconciliation).not.toHaveBeenCalled();
  });

  it("does not advance state when the atomic commit fails", async () => {
    const state = createState();
    const commitError = new Error("atomic commit failed");
    const commitReconciliation = vi.fn(
      async (
        _key: GitHubPollingProjectionKey,
        _events: readonly NormalizedSchedulingEvent[],
        _projection: GitHubPollingActiveProjection,
        _signal: AbortSignal,
      ) => {
        throw commitError;
      },
    );
    const observeError = vi.fn();
    const coordinator = new GitHubPollingCoordinator({
      client: createClient(),
      repositories: [repositoryTarget],
      reviewer,
      intervalMs: 60_000,
      stateSource: state,
      commitReconciliation,
      observeError,
      signal: new AbortController().signal,
    });

    const outcomes = await coordinator.pollOnce();

    expect(outcomes).toMatchObject([{ status: "rejected", error: commitError }]);
    expect(commitReconciliation).toHaveBeenCalledOnce();
    expect(commitReconciliation.mock.calls[0]?.[1].map((event) => event.action)).toEqual([
      "request_opened",
      "revision_observed",
    ]);
    expect(state.writeActiveProjection).not.toHaveBeenCalled();
    await expect(
      state.readActiveProjection(
        {
          githubRepositoryId: repositoryTarget.githubRepositoryId,
          repositoryFullName: repositoryTarget.fullName,
          reviewerGithubUserId: reviewer.githubUserId,
        },
        undefined,
      ),
    ).resolves.toBeNull();
    expect(observeError).toHaveBeenCalledWith(
      commitError,
      expect.objectContaining({ repository: repositoryTarget }),
    );
  });

  it("does not advance state when shutdown aborts the atomic commit", async () => {
    const controller = new AbortController();
    const state = createState();
    const shutdownError = new Error("shutdown");
    const commitReconciliation = vi.fn(
      async (
        _key: GitHubPollingProjectionKey,
        _events: readonly NormalizedSchedulingEvent[],
        _projection: GitHubPollingActiveProjection,
        signal: AbortSignal,
      ) => {
        controller.abort(shutdownError);
        signal.throwIfAborted();
      },
    );
    const coordinator = new GitHubPollingCoordinator({
      client: createClient(),
      repositories: [repositoryTarget],
      reviewer,
      intervalMs: 60_000,
      stateSource: state,
      commitReconciliation,
      signal: controller.signal,
    });

    await expect(coordinator.pollOnce()).rejects.toBe(shutdownError);
    expect(commitReconciliation).toHaveBeenCalledOnce();
    expect(state.writeActiveProjection).not.toHaveBeenCalled();
  });

  it("resolves its run loop cleanly when the shutdown signal aborts during the wait", async () => {
    const controller = new AbortController();
    const client = createClient();
    const state = createState();
    const sleep = vi.fn(async (_delayMs: number, signal: AbortSignal) => {
      controller.abort(new Error("shutdown"));
      signal.throwIfAborted();
    });
    const coordinator = new GitHubPollingCoordinator({
      client,
      repositories: [repositoryTarget],
      reviewer,
      intervalMs: 1_000,
      stateSource: state,
      commitReconciliation: (key, _events, projection, signal) =>
        state.writeActiveProjection(key, projection, signal),
      signal: controller.signal,
      sleep,
    });

    await expect(coordinator.run()).resolves.toBeUndefined();
    expect(sleep).toHaveBeenCalledOnce();
    expect(client.getRepository).toHaveBeenCalledOnce();
  });
});
