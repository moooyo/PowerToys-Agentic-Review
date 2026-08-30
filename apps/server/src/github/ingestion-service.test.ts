import type { NormalizedSchedulingEvent, SelfOrAllowlistPolicy } from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubEventIngestionService,
  GitHubRepositoryNotConfiguredError,
} from "./ingestion-service.js";

const actor = { githubUserId: 10, login: "reviewer", accountType: "user" } as const;
const repository = {
  githubRepositoryId: 1,
  githubNodeId: "R_1",
  ownerLogin: "microsoft",
  name: "PowerToys",
  fullName: "microsoft/PowerToys",
  htmlUrl: "https://github.com/microsoft/PowerToys",
  defaultBranch: "main",
  isPrivate: false,
} as const;
const event = {
  contractVersion: 1,
  eventId: "event-1",
  source: "poll",
  sourceEventId: "source-1",
  occurredAt: "2026-08-30T00:00:00.000Z",
  observedAt: "2026-08-30T00:00:01.000Z",
  repository,
  workItem: {
    kind: "issue",
    githubWorkItemId: 2,
    githubNodeId: "I_2",
    githubRepositoryId: 1,
    number: 2,
    title: "Issue",
    body: null,
    state: "open",
    author: actor,
    htmlUrl: "https://github.com/microsoft/PowerToys/issues/2",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    closedAt: null,
  },
  revision: {
    kind: "issue",
    githubRepositoryId: 1,
    githubWorkItemId: 2,
    revisionKey: "a".repeat(64),
    contentDigest: "a".repeat(64),
    observedAt: "2026-08-30T00:00:01.000Z",
    sourceUpdatedAt: "2026-08-30T00:00:00.000Z",
  },
  author: actor,
  action: "request_opened",
  requestKind: "assignment",
  actor,
  target: actor,
} satisfies NormalizedSchedulingEvent;
const policy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: 10,
  allowlistedActorGithubUserIds: [],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "inherit_authorized_epoch",
} satisfies SelfOrAllowlistPolicy;

describe("GitHubEventIngestionService", () => {
  it("passes the same normalized event, policy, delivery, and candidate schedule to the database", async () => {
    const result = {
      outcome: "processed" as const,
      eventId: "stored-event",
      repositoryId: "repository-1",
      workItemId: "work-item-1",
      workItemProjected: true,
      authorizationDecisionIds: [],
      authorized: false,
      activeRequestEpochIds: [],
      openedRequestEpochId: null,
      closedRequestEpochIds: [],
      jobId: null,
      jobCreated: false,
      staleJobCount: 0,
      cancelRequestedJobCount: 0,
    };
    const request = vi.fn().mockResolvedValue(result);
    const schedule = {
      jobKind: "issue_triage" as const,
      priority: 0,
      intentVersion: 1,
      maxAttempts: 1,
      executionTemplate: {} as never,
      requiredCapabilities: {},
    };
    const service = new GitHubEventIngestionService({
      database: { request } as never,
      repositories: [{ githubRepositoryId: 1, fullName: "microsoft/PowerToys" }],
      policy,
      createSchedule: () => schedule,
    });
    const delivery = {
      deliveryId: "delivery-1",
      eventName: "issues",
      payloadSha256: "b".repeat(64),
      receivedAt: "2026-08-30T00:00:01.000Z",
    };

    await expect(service.ingest(event, delivery)).resolves.toEqual(result);
    expect(request).toHaveBeenCalledWith("ingestSchedulingEvent", {
      event,
      policy,
      delivery,
      schedule,
    });
  });

  it("rejects an event whose numeric repository ID is not configured", async () => {
    const request = vi.fn();
    const service = new GitHubEventIngestionService({
      database: { request } as never,
      repositories: [{ githubRepositoryId: 99, fullName: repository.fullName }],
      policy,
      createSchedule: () => null,
    });

    await expect(service.ingest(event)).rejects.toBeInstanceOf(GitHubRepositoryNotConfiguredError);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a name mismatch even when the numeric repository ID matches", async () => {
    const request = vi.fn();
    const service = new GitHubEventIngestionService({
      database: { request } as never,
      repositories: [{ githubRepositoryId: 1, fullName: "microsoft/Other" }],
      policy,
      createSchedule: () => null,
    });

    await expect(service.ingest(event)).rejects.toBeInstanceOf(GitHubRepositoryNotConfiguredError);
    expect(request).not.toHaveBeenCalled();
  });
});
