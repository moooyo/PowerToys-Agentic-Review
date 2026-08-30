import type { NormalizedSchedulingEvent } from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";

import type {
  GitHubIssueSnapshot,
  GitHubPollingActiveProjection,
  GitHubPollingProjectionKey,
  GitHubPollingStateSink,
  GitHubPollingStateSource,
  GitHubReadClient,
} from "../../dist/github/poller.js";
import {
  GitHubPollingCoordinator,
  type GitHubPollingRepositoryOutcome,
} from "../../dist/github/polling-coordinator.js";

const repositoryTarget = { githubRepositoryId: 1, fullName: "microsoft/PowerToys" };
const reviewer = { githubUserId: 100, login: "reviewer" };
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

    expect(outcomes).toMatchObject<readonly GitHubPollingRepositoryOutcome[]>([
      { status: "fulfilled", repository: repositoryTarget },
    ]);
    expect(client.getRepository).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
    expect(calls).toEqual(["commit"]);
    expect(state.writeActiveProjection).toHaveBeenCalledOnce();
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
    expect(commitReconciliation.mock.calls[0]?.[1]).toHaveLength(1);
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
