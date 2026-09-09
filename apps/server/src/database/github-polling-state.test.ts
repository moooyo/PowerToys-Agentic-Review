import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { NormalizedSchedulingEvent, SelfOrAllowlistPolicy } from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import {
  DatabaseGitHubPollingState,
  type GitHubPollingReconciliationEventInput,
} from "../../dist/database/github-polling-state.js";
import type { IngestSchedulingEventInput } from "../../dist/database/protocol.js";
import {
  type GitHubPollingActiveProjection,
  type GitHubPollingProjectionKey,
  type GitHubPullRequestSnapshot,
  type GitHubReadClient,
  type GitHubTimelineEvent,
  reconcileGitHubPolling,
} from "../../dist/github/poller.js";
import { createPullRequestRevisionKey } from "../../dist/github/revision-key.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));

interface Fixture {
  readonly clients: DatabaseClient[];
  readonly databasePath: string;
  readonly directory: string;
}

const fixtures: Fixture[] = [];

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const key: GitHubPollingProjectionKey = {
  githubRepositoryId: 1,
  repositoryFullName: "microsoft/PowerToys",
  reviewerGithubUserId: 100,
};

const pollingPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: key.reviewerGithubUserId,
  allowlistedActorGithubUserIds: [],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "inherit_authorized_epoch",
} satisfies SelfOrAllowlistPolicy;

const reviewer = {
  githubUserId: key.reviewerGithubUserId,
  login: "reviewer",
  accountType: "user",
} as const;

const projection = (
  reviewerLogin: string,
  openedSourceEventId: string,
): GitHubPollingActiveProjection => {
  const contentDigest = sha256(`issue-body:${openedSourceEventId}`);
  return {
    version: 1,
    githubRepositoryId: key.githubRepositoryId,
    repositoryFullName: key.repositoryFullName,
    reviewerGithubUserId: key.reviewerGithubUserId,
    reviewerLogin,
    workItems: [
      {
        workItem: {
          kind: "issue",
          githubWorkItemId: 501,
          githubNodeId: "I_501",
          githubRepositoryId: key.githubRepositoryId,
          number: 501,
          title: "Persist polling projection",
          body: `Body for ${openedSourceEventId}`,
          state: "open",
          author: {
            githubUserId: 200,
            login: "issue-author",
            accountType: "user",
          },
          htmlUrl: "https://github.com/microsoft/PowerToys/issues/501",
          createdAt: "2026-08-30T10:00:00.000Z",
          updatedAt: "2026-08-30T10:05:00.000Z",
          closedAt: null,
        },
        revision: {
          kind: "issue",
          githubRepositoryId: key.githubRepositoryId,
          githubWorkItemId: 501,
          revisionKey: contentDigest,
          contentDigest,
          observedAt: "2026-08-30T10:06:00.000Z",
          sourceUpdatedAt: "2026-08-30T10:05:00.000Z",
        },
        activeRequests: [
          {
            requestKind: "assignment",
            openedSourceEventId,
            openedAt: "2026-08-30T10:04:00.000Z",
          },
        ],
      },
    ],
  };
};

const reconciliationEntry = (
  sourceEventId: string,
  activeProjection: GitHubPollingActiveProjection,
): GitHubPollingReconciliationEventInput => {
  const projected = activeProjection.workItems[0];
  if (
    projected === undefined ||
    projected.workItem.kind !== "issue" ||
    projected.revision.kind !== "issue"
  ) {
    throw new Error("The polling test fixture requires one projected issue.");
  }
  const event = {
    contractVersion: 1,
    eventId: `poll-event:${sourceEventId}`,
    source: "poll",
    sourceEventId,
    occurredAt: "2026-08-30T10:04:00.000Z",
    observedAt: projected.revision.observedAt,
    repository: {
      githubRepositoryId: key.githubRepositoryId,
      githubNodeId: "R_1",
      ownerLogin: "microsoft",
      name: "PowerToys",
      fullName: key.repositoryFullName,
      htmlUrl: "https://github.com/microsoft/PowerToys",
      defaultBranch: "main",
      isPrivate: false,
    },
    workItem: projected.workItem,
    revision: projected.revision,
    author: projected.workItem.author,
    action: "request_opened",
    requestKind: "assignment",
    actor: reviewer,
    target: reviewer,
  } satisfies NormalizedSchedulingEvent;
  const renderedPrompt = "Triage this polling issue.";
  return {
    event,
    policy: pollingPolicy,
    schedule: {
      jobKind: "issue_triage",
      priority: 10,
      intentVersion: 1,
      maxAttempts: 3,
      requiredCapabilities: [],
      executionTemplate: {
        repository: {
          githubRepositoryId: key.githubRepositoryId,
          fullName: key.repositoryFullName,
        },
        resource: {
          kind: "issue",
          githubNodeId: projected.workItem.githubNodeId,
          number: projected.workItem.number,
          title: projected.workItem.title,
          author: projected.workItem.author,
          canonicalSnapshot: projected.workItem,
          revisionDigest: projected.revision.revisionKey,
        },
        prompt: {
          name: "issue-triage",
          version: "test",
          renderedPrompt,
          promptSha256: sha256(renderedPrompt),
          outputSchema: {},
          outputSchemaSha256: sha256("{}"),
        },
        executionPolicy: {
          hardTimeoutMs: 600_000,
          noProgressTimeoutMs: 600_000,
          allowedRecipeIds: ["issue-triage"],
          requiredCapabilityLabels: {},
        },
      },
    },
  };
};

const pullRequestReconciliationEntry = (
  event: NormalizedSchedulingEvent,
): GitHubPollingReconciliationEventInput => {
  if (event.action !== "request_opened" && event.action !== "revision_observed") {
    return { event, policy: pollingPolicy, schedule: null };
  }
  if (event.workItem.kind !== "pull_request" || event.revision.kind !== "pull_request") {
    throw new Error("The polling test schedule requires a pull request.");
  }
  const renderedPrompt = "Review the polled pull request.";
  return {
    event,
    policy: pollingPolicy,
    schedule: {
      jobKind: "pull_request_review",
      priority: 10,
      intentVersion: 1,
      maxAttempts: 3,
      requiredCapabilities: [],
      executionTemplate: {
        repository: {
          githubRepositoryId: event.repository.githubRepositoryId,
          fullName: event.repository.fullName,
        },
        resource: {
          kind: "pull_request",
          githubNodeId: event.workItem.githubNodeId,
          number: event.workItem.number,
          title: event.workItem.title,
          author: event.workItem.author,
          canonicalSnapshot: event.workItem,
          baseSha: event.revision.baseSha,
          headSha: event.revision.headSha,
          isDraft: event.workItem.isDraft,
        },
        prompt: {
          name: "pull-request-review",
          version: "test",
          renderedPrompt,
          promptSha256: sha256(renderedPrompt),
          outputSchema: {},
          outputSchemaSha256: sha256("{}"),
        },
        executionPolicy: {
          hardTimeoutMs: 600_000,
          noProgressTimeoutMs: 600_000,
          allowedRecipeIds: ["pull-request-review"],
          requiredCapabilityLabels: {},
        },
      },
    },
  };
};

const webhookOpening = (
  sourceEventId: string,
  activeProjection: GitHubPollingActiveProjection,
): IngestSchedulingEventInput => {
  const entry = reconciliationEntry(sourceEventId, activeProjection);
  return {
    ...entry,
    event: { ...entry.event, source: "webhook", eventId: `webhook-event:${sourceEventId}` },
    delivery: {
      deliveryId: sourceEventId,
      eventName: "issues",
      receivedAt: entry.event.observedAt,
      payloadSha256: sha256(sourceEventId),
    },
  };
};

const createFixture = async (): Promise<Fixture> => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-github-polling-"));
  const databasePath = join(directory, "server.sqlite");
  try {
    const client = await DatabaseClient.create({ databasePath, migrationsDirectory });
    const fixture = { clients: [client], databasePath, directory };
    fixtures.push(fixture);
    return fixture;
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const client of fixture.clients) {
      await client.close();
    }
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

describe("DatabaseGitHubPollingState", () => {
  it("returns null when no projection has been persisted", async () => {
    const { clients } = await createFixture();
    const state = new DatabaseGitHubPollingState(clients[0] as DatabaseClient);

    await expect(state.readActiveProjection(key, undefined)).resolves.toBeNull();
  });

  it("seeds an uncheckpointed webhook request without writing state or crossing repository and reviewer scopes", async () => {
    const { clients, databasePath } = await createFixture();
    const client = clients[0] as DatabaseClient;
    const state = new DatabaseGitHubPollingState(client);
    const openingProjection = projection("reviewer", "webhook:uncheckpointed");
    const opening = webhookOpening("webhook:uncheckpointed", openingProjection);
    const result = await client.request("ingestSchedulingEvent", opening);

    expect(result).toMatchObject({ authorized: true, jobCreated: true });
    await expect(state.readActiveProjection(key, undefined)).resolves.toEqual({
      ...openingProjection,
      workItems: openingProjection.workItems.map((item) => ({
        ...item,
        needsRevisionObservation: true,
      })),
    });
    await expect(
      state.readActiveProjection({ ...key, reviewerGithubUserId: 101 }, undefined),
    ).resolves.toBeNull();
    await expect(
      state.readActiveProjection({ ...key, githubRepositoryId: 2 }, undefined),
    ).resolves.toBeNull();
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        reader.prepare("SELECT COUNT(*) AS count FROM github_polling_projections").get(),
      ).toEqual({
        count: 0,
      });
      expect(reader.prepare("SELECT COUNT(*) AS count FROM github_events").get()).toEqual({
        count: 1,
      });
      expect(reader.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 1 });
    } finally {
      reader.close();
    }
  });

  it("adds missing webhook work items while retaining checkpoint snapshots", async () => {
    const { clients } = await createFixture();
    const client = clients[0] as DatabaseClient;
    const state = new DatabaseGitHubPollingState(client);
    const checkpoint = projection("reviewer", "poll:already-observed");
    await state.writeActiveProjection(key, checkpoint, undefined);
    const extra = projection("reviewer", "webhook:missing-item");
    const extraProjection: GitHubPollingActiveProjection = {
      ...extra,
      workItems: extra.workItems.map((item) => ({
        ...item,
        workItem: {
          ...item.workItem,
          githubWorkItemId: 502,
          githubNodeId: "I_502",
          number: 502,
          htmlUrl: "https://github.com/microsoft/PowerToys/issues/502",
        },
        revision: { ...item.revision, githubWorkItemId: 502 },
      })),
    };
    await client.request(
      "ingestSchedulingEvent",
      webhookOpening("webhook:missing-item", extraProjection),
    );

    const restored = await state.readActiveProjection(key, undefined);

    expect(restored?.workItems).toEqual([
      ...checkpoint.workItems,
      ...extraProjection.workItems.map((item) => ({ ...item, needsRevisionObservation: true })),
    ]);
  });

  it("merges request kinds authorized at different revisions and clears seed observation after a complete checkpoint", async () => {
    const { clients } = await createFixture();
    const client = clients[0] as DatabaseClient;
    const state = new DatabaseGitHubPollingState(client);
    const opening = (
      requestKind: "assignment" | "review_request",
      headSha: string,
      occurredAt: string,
    ): IngestSchedulingEventInput => {
      const sourceEventId = `webhook:${requestKind}`;
      const base = webhookOpening(sourceEventId, projection("reviewer", sourceEventId));
      if (base.event.action !== "request_opened") throw new Error("Expected an opening fixture.");
      const event = {
        ...base.event,
        requestKind,
        occurredAt,
        observedAt: occurredAt,
        workItem: {
          ...base.event.workItem,
          kind: "pull_request",
          isDraft: false,
          htmlUrl: "https://github.com/microsoft/PowerToys/pull/501",
          updatedAt: occurredAt,
        },
        revision: {
          kind: "pull_request",
          githubRepositoryId: key.githubRepositoryId,
          githubWorkItemId: 501,
          baseSha: "a".repeat(40),
          headSha,
          revisionKey: createPullRequestRevisionKey("a".repeat(40), headSha),
          sourceUpdatedAt: occurredAt,
          observedAt: occurredAt,
        },
      } satisfies NormalizedSchedulingEvent;
      return {
        ...base,
        schedule: pullRequestReconciliationEntry(event).schedule,
        policy: { ...pollingPolicy, newRevisionPolicy: "require_new_authorization" },
        event,
      };
    };
    const assignment = opening("assignment", "b".repeat(40), "2026-08-30T10:04:00.000Z");
    const requested = opening("review_request", "c".repeat(40), "2026-08-30T10:05:00.000Z");
    await client.request("ingestSchedulingEvent", assignment);
    const firstSeed = await state.readActiveProjection(key, undefined);
    if (firstSeed === null) throw new Error("Expected a seeded assignment.");
    const checkpoint: GitHubPollingActiveProjection = {
      ...firstSeed,
      workItems: firstSeed.workItems.map(({ needsRevisionObservation: _marker, ...item }) => item),
    };
    await state.writeActiveProjection(key, checkpoint, undefined);
    await client.request("ingestSchedulingEvent", requested);

    const merged = await state.readActiveProjection(key, undefined);

    expect(merged?.workItems[0]).toMatchObject({
      workItem: assignment.event.workItem,
      revision: assignment.event.revision,
      needsRevisionObservation: true,
      activeRequests: [
        { requestKind: "assignment", openedSourceEventId: assignment.event.sourceEventId },
        { requestKind: "review_request", openedSourceEventId: requested.event.sourceEventId },
      ],
    });
    if (merged === null) throw new Error("Expected a merged checkpoint.");
    const completed: GitHubPollingActiveProjection = {
      ...merged,
      workItems: merged.workItems.map(({ needsRevisionObservation: _marker, ...item }) => ({
        ...item,
        workItem: requested.event.workItem,
        revision: requested.event.revision,
      })),
    };
    await state.writeActiveProjection(key, completed, undefined);
    await expect(state.readActiveProjection(key, undefined)).resolves.toEqual(completed);
  });

  it("replaces a stale checkpoint origin after a newer webhook epoch opens", async () => {
    const { clients } = await createFixture();
    const client = clients[0] as DatabaseClient;
    const state = new DatabaseGitHubPollingState(client);
    const checkpoint = projection("reviewer", "webhook:old-origin");
    const first = webhookOpening("webhook:old-origin", checkpoint);
    await client.request("ingestSchedulingEvent", first);
    await state.writeActiveProjection(key, checkpoint, undefined);
    await client.request("ingestSchedulingEvent", {
      event: {
        ...first.event,
        eventId: "reconciliation:old-origin-closed",
        source: "reconciliation",
        sourceEventId: "reconciliation:old-origin-closed",
        action: "request_closed",
        requestKind: "assignment",
        closeReason: "assignment_removed",
        occurredAt: "2026-08-30T10:06:00.000Z",
      },
      policy: pollingPolicy,
      schedule: null,
      delivery: null,
    });
    await expect(state.readActiveProjection(key, undefined)).resolves.toEqual(checkpoint);
    const replacement: IngestSchedulingEventInput = {
      ...first,
      event: {
        ...first.event,
        eventId: "webhook-event:new-origin",
        sourceEventId: "webhook:new-origin",
        occurredAt: "2026-08-30T10:07:00.000Z",
        observedAt: "2026-08-30T10:07:00.000Z",
      },
      delivery: {
        deliveryId: "webhook:new-origin",
        eventName: "issues",
        receivedAt: "2026-08-30T10:07:00.000Z",
        payloadSha256: sha256("webhook:new-origin"),
      },
    };
    const reopened = await client.request("ingestSchedulingEvent", replacement);
    expect(reopened.openedRequestEpochId).not.toBeNull();

    const restored = await state.readActiveProjection(key, undefined);

    expect(restored?.workItems[0]).toEqual({
      ...checkpoint.workItems[0],
      needsRevisionObservation: true,
      activeRequests: [
        {
          requestKind: "assignment",
          openedSourceEventId: "webhook:new-origin",
          openedAt: "2026-08-30T10:07:00.000Z",
        },
      ],
    });
  });

  it("retains a persisted polling source that proves the same cross-transport request origin", async () => {
    const { clients } = await createFixture();
    const client = clients[0] as DatabaseClient;
    const state = new DatabaseGitHubPollingState(client);
    const openingProjection = projection("reviewer", "webhook:shared-origin");
    await client.request(
      "ingestSchedulingEvent",
      webhookOpening("webhook:shared-origin", openingProjection),
    );
    const pollSourceId = "poll:shared-origin";
    const checkpoint: GitHubPollingActiveProjection = {
      ...openingProjection,
      workItems: openingProjection.workItems.map((item) => ({
        ...item,
        activeRequests: item.activeRequests.map((request) => ({
          ...request,
          openedSourceEventId: pollSourceId,
        })),
      })),
    };
    const pollEntry = reconciliationEntry(pollSourceId, checkpoint);
    await state.commitReconciliation(key, checkpoint, [pollEntry], undefined);

    await expect(state.readActiveProjection(key, undefined)).resolves.toEqual(checkpoint);
    await expect(client.request("listJobs", {})).resolves.toMatchObject({ total: 1 });
  });

  it("replaces distinct same-transport origins even when actor and timestamps match", async () => {
    const { clients } = await createFixture();
    const client = clients[0] as DatabaseClient;
    const state = new DatabaseGitHubPollingState(client);
    const checkpoint = projection("reviewer", "poll:first-same-clock");
    const first = reconciliationEntry("poll:first-same-clock", checkpoint);
    const original = await state.commitReconciliation(key, checkpoint, [first], undefined);
    const replacement = await client.request("ingestSchedulingEvent", {
      ...first,
      event: {
        ...first.event,
        eventId: "poll-event:second-same-clock",
        sourceEventId: "poll:second-same-clock",
      },
      delivery: null,
    });
    expect(replacement.openedRequestEpochId).not.toBe(original[0]?.openedRequestEpochId);

    const restored = await state.readActiveProjection(key, undefined);

    expect(restored?.workItems[0]).toMatchObject({
      needsRevisionObservation: true,
      activeRequests: [
        { requestKind: "assignment", openedSourceEventId: "poll:second-same-clock" },
      ],
    });
  });

  it("seeds from the opening snapshot when a newer stored work item is already closed", async () => {
    const { clients, databasePath } = await createFixture();
    const client = clients[0] as DatabaseClient;
    const state = new DatabaseGitHubPollingState(client);
    const openingProjection = projection("reviewer", "webhook:open-snapshot");
    const opening = webhookOpening("webhook:open-snapshot", openingProjection);
    await client.request("ingestSchedulingEvent", {
      ...opening,
      event: { ...opening.event, occurredAt: "2026-08-30T10:10:00.000Z" },
    });
    await client.request("ingestSchedulingEvent", {
      event: {
        ...opening.event,
        eventId: "reconciliation:older-close",
        source: "reconciliation",
        sourceEventId: "reconciliation:older-close",
        action: "work_item_closed",
        requestKind: null,
        actor: null,
        target: null,
        closeReason: "work_item_closed",
        occurredAt: "2026-08-30T10:07:00.000Z",
        observedAt: "2026-08-30T10:11:00.000Z",
        workItem: {
          ...opening.event.workItem,
          state: "closed",
          updatedAt: "2026-08-30T10:07:00.000Z",
          closedAt: "2026-08-30T10:07:00.000Z",
        },
      },
      policy: pollingPolicy,
      delivery: null,
      schedule: null,
    });
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(reader.prepare("SELECT state FROM work_items").get()).toEqual({ state: "closed" });
      expect(reader.prepare("SELECT status FROM request_epochs").get()).toEqual({
        status: "active",
      });
    } finally {
      reader.close();
    }

    const restored = await state.readActiveProjection(key, undefined);

    expect(restored?.workItems[0]?.workItem).toEqual(opening.event.workItem);
    expect(restored?.workItems[0]?.activeRequests[0]?.openedAt).toBe("2026-08-30T10:10:00.000Z");
  });

  it("atomically replaces and reads a complete projection", async () => {
    const { clients, databasePath } = await createFixture();
    const state = new DatabaseGitHubPollingState(clients[0] as DatabaseClient);
    const first = projection("reviewer-before-rename", "poll:assignment:1");
    const replacement = projection("reviewer-after-rename", "poll:assignment:2");

    await state.writeActiveProjection(key, first, undefined);
    await expect(state.readActiveProjection(key, undefined)).resolves.toEqual(first);
    await state.writeActiveProjection(key, replacement, undefined);
    await expect(state.readActiveProjection(key, undefined)).resolves.toEqual(replacement);

    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = reader
        .prepare(`
          SELECT COUNT(*) AS count, projection_json AS "projectionJson"
          FROM github_polling_projections
        `)
        .get() as unknown as { readonly count: number; readonly projectionJson: string };
      expect(row.count).toBe(1);
      expect(JSON.parse(row.projectionJson)).toEqual(replacement);
    } finally {
      reader.close();
    }
  });

  it("rejects projection identities that do not match the persistence key", async () => {
    const { clients } = await createFixture();
    const state = new DatabaseGitHubPollingState(clients[0] as DatabaseClient);
    const valid = projection("reviewer", "poll:assignment:identity");
    const mismatches: GitHubPollingActiveProjection[] = [
      { ...valid, githubRepositoryId: 2 },
      { ...valid, repositoryFullName: "microsoft/OtherRepository" },
      { ...valid, reviewerGithubUserId: 101 },
    ];

    for (const mismatch of mismatches) {
      await expect(state.writeActiveProjection(key, mismatch, undefined)).rejects.toThrow(
        "The GitHub polling projection does not match its persistence key.",
      );
    }
    await expect(state.readActiveProjection(key, undefined)).resolves.toBeNull();
  });

  it("restores the projection after the DatabaseClient is restarted", async () => {
    const fixture = await createFixture();
    const persisted = projection("reviewer", "poll:assignment:restart");
    const firstState = new DatabaseGitHubPollingState(fixture.clients[0] as DatabaseClient);
    await firstState.writeActiveProjection(key, persisted, undefined);
    await fixture.clients[0]?.close();

    const restartedClient = await DatabaseClient.create({
      databasePath: fixture.databasePath,
      migrationsDirectory,
    });
    fixture.clients.push(restartedClient);
    const restartedState = new DatabaseGitHubPollingState(restartedClient);

    await expect(restartedState.readActiveProjection(key, undefined)).resolves.toEqual(persisted);
  });

  it("commits normalized events and the polling checkpoint in one transaction", async () => {
    const { clients } = await createFixture();
    const client = clients[0] as DatabaseClient;
    const state = new DatabaseGitHubPollingState(client);
    const checkpoint = projection("reviewer", "poll:atomic:1");
    const entry = reconciliationEntry("poll:atomic:1", checkpoint);

    const results = await state.commitReconciliation(key, checkpoint, [entry], undefined);
    const jobs = await client.request("listJobs", {});

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      outcome: "processed",
      authorized: true,
      jobCreated: true,
    });
    await expect(state.readActiveProjection(key, undefined)).resolves.toEqual(checkpoint);
    expect(jobs.total).toBe(1);
  });

  it("opens a new epoch and job when the same pull request revision is reassigned", async () => {
    const { clients, databasePath } = await createFixture();
    const client = clients[0] as DatabaseClient;
    const state = new DatabaseGitHubPollingState(client);
    let assigned = true;
    let snapshot: GitHubPullRequestSnapshot = {
      kind: "pull_request",
      githubWorkItemId: 501,
      githubNodeId: "PR_501",
      number: 501,
      title: "Review the same revision after reassignment",
      body: "The assignment can be renewed without changing the commits.",
      state: "open",
      author: { githubUserId: 200, login: "pull-request-author", accountType: "user" },
      htmlUrl: "https://github.com/microsoft/PowerToys/pull/501",
      createdAt: "2026-08-30T10:00:00.000Z",
      updatedAt: "2026-08-30T10:05:00.000Z",
      closedAt: null,
      isDraft: false,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    };
    let timeline: GitHubTimelineEvent[] = [
      {
        githubEventId: 1_001,
        action: "assigned",
        actor: reviewer,
        target: reviewer,
        occurredAt: snapshot.updatedAt,
      },
    ];
    const github: GitHubReadClient = {
      getRepository: async () => ({
        githubRepositoryId: key.githubRepositoryId,
        githubNodeId: "R_1",
        fullName: key.repositoryFullName,
        htmlUrl: "https://github.com/microsoft/PowerToys",
        defaultBranch: "main",
        isPrivate: false,
      }),
      searchIssuesAndPullRequests: async (request) => ({
        items:
          assigned && !request.query.includes("review-requested")
            ? [
                {
                  kind: "pull_request",
                  githubWorkItemId: snapshot.githubWorkItemId,
                  number: snapshot.number,
                },
              ]
            : [],
        nextPage: null,
      }),
      getIssue: async () => {
        throw new Error("The reassignment fixture only supports pull requests.");
      },
      getPullRequest: async () => snapshot,
      listIssueTimelineEvents: async () => ({ items: timeline, nextPage: null }),
    };
    const pollAndCommit = async (observedAt: string) => {
      const entries: GitHubPollingReconciliationEventInput[] = [];
      const result = await reconcileGitHubPolling({
        client: github,
        repository: {
          githubRepositoryId: key.githubRepositoryId,
          fullName: key.repositoryFullName,
        },
        reviewer,
        previousActiveProjection: await state.readActiveProjection(key, undefined),
        now: () => new Date(observedAt),
        ingest: (event) => {
          entries.push(pullRequestReconciliationEntry(event));
        },
      });
      const eventResults = await state.commitReconciliation(
        key,
        result.nextActiveProjection,
        entries,
        undefined,
      );
      return { entries, eventResults, projection: result.nextActiveProjection };
    };

    const first = await pollAndCommit("2026-08-30T10:05:30.000Z");
    assigned = false;
    snapshot = { ...snapshot, updatedAt: "2026-08-30T10:06:00.000Z" };
    timeline.push({
      githubEventId: 1_002,
      action: "unassigned",
      actor: reviewer,
      target: reviewer,
      occurredAt: snapshot.updatedAt,
    });
    const closed = await pollAndCommit("2026-08-30T10:06:30.000Z");
    expect(closed.eventResults[0]).toMatchObject({
      closedRequestEpochIds: [first.eventResults[0]?.openedRequestEpochId],
      activeRequestEpochIds: [],
      staleJobCount: 1,
    });
    expect(closed.projection.workItems).toEqual([]);

    assigned = true;
    snapshot = { ...snapshot, updatedAt: "2026-08-30T10:07:00.000Z" };
    timeline = [
      ...timeline,
      {
        githubEventId: 1_003,
        action: "assigned",
        actor: reviewer,
        target: reviewer,
        occurredAt: snapshot.updatedAt,
      },
    ];
    const reopened = await pollAndCommit("2026-08-30T10:07:30.000Z");
    expect(reopened.entries.map(({ event }) => event.action)).toEqual([
      "request_opened",
      "revision_observed",
    ]);
    expect(reopened.entries[1]?.event.revision.revisionKey).toBe(
      first.entries[1]?.event.revision.revisionKey,
    );
    expect(reopened.entries[1]?.event.sourceEventId).not.toBe(
      first.entries[1]?.event.sourceEventId,
    );
    expect(reopened.eventResults[0]).toMatchObject({ authorized: true, jobCreated: true });
    expect(reopened.eventResults[0]?.openedRequestEpochId).not.toBe(
      first.eventResults[0]?.openedRequestEpochId,
    );
    expect(reopened.eventResults[0]?.jobId).not.toBe(first.eventResults[0]?.jobId);
    await expect(state.readActiveProjection(key, undefined)).resolves.toEqual(reopened.projection);

    const repeated = await pollAndCommit("2026-08-30T10:08:30.000Z");
    expect(repeated.entries).toEqual([]);
    const jobs = await client.request("listJobs", {});
    expect(jobs.total).toBe(2);
    expect(jobs.items.map((job) => job.status).sort()).toEqual(["queued", "stale"]);
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        reader.prepare("SELECT ordinal, status FROM request_epochs ORDER BY ordinal").all(),
      ).toEqual([
        { ordinal: 1, status: "closed" },
        { ordinal: 2, status: "active" },
      ]);
    } finally {
      reader.close();
    }
  });

  it("rejects changed source identity for an existing event key without advancing its checkpoint", async () => {
    const { clients } = await createFixture();
    const client = clients[0] as DatabaseClient;
    const state = new DatabaseGitHubPollingState(client);
    const checkpoint = projection("reviewer", "poll:immutable:1");
    const entry = reconciliationEntry("poll:immutable:1", checkpoint);
    await state.commitReconciliation(key, checkpoint, [entry], undefined);
    const changedEntry: GitHubPollingReconciliationEventInput = {
      ...entry,
      schedule: null,
      event: {
        ...entry.event,
        actor: { ...reviewer, githubUserId: reviewer.githubUserId + 1 },
      },
    };
    const replacement = projection("reviewer", "poll:immutable:2");

    await expect(
      state.commitReconciliation(key, replacement, [changedEntry], undefined),
    ).rejects.toMatchObject({ code: "NORMALIZED_EVENT_CONFLICT" });
    await expect(state.readActiveProjection(key, undefined)).resolves.toEqual(checkpoint);
    await expect(client.request("listJobs", {})).resolves.toMatchObject({ total: 1 });
  });

  it("rolls back earlier events and the checkpoint when a later event fails", async () => {
    const { clients } = await createFixture();
    const client = clients[0] as DatabaseClient;
    const state = new DatabaseGitHubPollingState(client);
    const checkpoint = projection("reviewer", "poll:rollback:1");
    const first = reconciliationEntry("poll:rollback:1", checkpoint);
    const second = reconciliationEntry("poll:rollback:2", checkpoint);
    if (second.schedule === null) {
      throw new Error("The polling test fixture requires a candidate schedule.");
    }
    const invalidSecond: GitHubPollingReconciliationEventInput = {
      ...second,
      schedule: {
        ...second.schedule,
        executionTemplate: {
          ...second.schedule.executionTemplate,
          prompt: {
            ...second.schedule.executionTemplate.prompt,
            promptSha256: "0".repeat(64),
          },
        },
      },
    };

    await expect(
      state.commitReconciliation(key, checkpoint, [first, invalidSecond], undefined),
    ).rejects.toThrow("The rendered prompt digest is inconsistent.");
    await expect(state.readActiveProjection(key, undefined)).resolves.toBeNull();
    await expect(client.request("listWorkItems", {})).resolves.toMatchObject({ total: 0 });
    await expect(client.request("listJobs", {})).resolves.toMatchObject({ total: 0 });

    const retry = await state.commitReconciliation(key, checkpoint, [first], undefined);
    expect(retry[0]?.outcome).toBe("processed");
  });

  it("replays a committed event as a no-op while atomically advancing its checkpoint", async () => {
    const { clients } = await createFixture();
    const client = clients[0] as DatabaseClient;
    const state = new DatabaseGitHubPollingState(client);
    const checkpoint = projection("reviewer", "poll:replay:1");
    const entry = reconciliationEntry("poll:replay:1", checkpoint);

    const eventResult = await client.request("ingestSchedulingEvent", {
      ...entry,
      delivery: null,
    });
    expect(eventResult.outcome).toBe("processed");
    await expect(state.readActiveProjection(key, undefined)).resolves.toEqual({
      ...checkpoint,
      workItems: checkpoint.workItems.map((item) => ({ ...item, needsRevisionObservation: true })),
    });

    const replay = await state.commitReconciliation(key, checkpoint, [entry], undefined);
    const jobs = await client.request("listJobs", {});

    expect(replay[0]).toMatchObject({
      outcome: "duplicate",
      eventId: eventResult.eventId,
      jobId: eventResult.jobId,
    });
    await expect(state.readActiveProjection(key, undefined)).resolves.toEqual(checkpoint);
    expect(jobs.total).toBe(1);
  });
});
