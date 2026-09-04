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
import type {
  GitHubPollingActiveProjection,
  GitHubPollingProjectionKey,
} from "../../dist/github/poller.js";

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
        activeRequests: [{ requestKind: "assignment", openedSourceEventId }],
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
    await expect(state.readActiveProjection(key, undefined)).resolves.toBeNull();

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
