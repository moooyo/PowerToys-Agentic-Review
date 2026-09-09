import type { NormalizedSchedulingEvent, SelfOrAllowlistPolicy } from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ScheduleJobInput } from "../database/protocol.js";
import {
  GitHubEventIngestionService,
  type GitHubEventRuntimeConfiguration,
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
const dynamicPolicy = {
  ...policy,
  schedulingTargetGithubUserId: 42,
  allowlistedActorGithubUserIds: [actor.githubUserId],
} satisfies SelfOrAllowlistPolicy;
const dynamicSchedule = {
  jobKind: "issue_triage",
  priority: 5,
  intentVersion: 2,
  maxAttempts: 3,
  executionTemplate: {} as never,
  requiredCapabilities: { platform: "linux" },
} satisfies ScheduleJobInput;
const dynamicConfiguration = {
  repository: { githubRepositoryId: 1, fullName: "Microsoft/PowerToys" },
  policy: dynamicPolicy,
  allowScheduling: true,
  schedule: dynamicSchedule,
} satisfies GitHubEventRuntimeConfiguration;

describe("GitHubEventIngestionService", () => {
  it("supports runtime-only admission without legacy repository or reviewer placeholders", async () => {
    const request = vi.fn();
    const resolveConfiguration = vi.fn(async () => null);
    const service = new GitHubEventIngestionService({
      database: { request } as never,
      resolveConfiguration,
    });
    await expect(service.ingest(event)).rejects.toBeInstanceOf(GitHubRepositoryNotConfiguredError);
    expect(resolveConfiguration).toHaveBeenCalledWith(event);
    expect(request).not.toHaveBeenCalled();
  });

  it("requires legacy repository, policy, and factory settings to be provided together", () => {
    const database = { request: vi.fn() } as never;
    expect(() => new GitHubEventIngestionService({ database })).toThrow(/complete legacy/u);
    for (const partial of [
      { repositories: [repository] },
      { policy },
      { createSchedule: () => null },
    ]) {
      expect(
        () =>
          new GitHubEventIngestionService({
            database,
            resolveConfiguration: () => null,
            ...partial,
          }),
      ).toThrow(/complete legacy/u);
    }
  });

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

  it.each([
    { name: "an empty bootstrap repository list", repositories: [] },
    {
      name: "a bootstrap list for a different repository",
      repositories: [{ githubRepositoryId: 99, fullName: "other/project" }],
    },
  ])("uses the resolved repository, policy, and schedule with $name", async ({ repositories }) => {
    const request = vi.fn();
    const createSchedule = vi.fn();
    const resolveConfiguration = vi.fn().mockResolvedValue(dynamicConfiguration);
    const service = new GitHubEventIngestionService({
      database: { request } as never,
      repositories,
      policy,
      createSchedule,
      resolveConfiguration,
    });
    const delivery = {
      deliveryId: "dynamic-delivery",
      eventName: "issues",
      payloadSha256: "c".repeat(64),
      receivedAt: "2026-08-30T00:00:01.000Z",
    };

    await service.ingest(event, delivery);

    expect(resolveConfiguration).toHaveBeenCalledExactlyOnceWith(event);
    expect(createSchedule).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledExactlyOnceWith("ingestSchedulingEvent", {
      event,
      policy: dynamicPolicy,
      delivery,
      allowScheduling: true,
      schedule: dynamicSchedule,
    });
  });

  it.each([
    { name: "missing", configuration: null },
    {
      name: "for a different numeric repository ID",
      configuration: {
        ...dynamicConfiguration,
        repository: { ...dynamicConfiguration.repository, githubRepositoryId: 99 },
      },
    },
    {
      name: "for a different repository name",
      configuration: {
        ...dynamicConfiguration,
        repository: { ...dynamicConfiguration.repository, fullName: "microsoft/Other" },
      },
    },
  ])(
    "rejects a resolved configuration that is $name without falling back",
    async ({ configuration }) => {
      const request = vi.fn();
      const createSchedule = vi.fn();
      const service = new GitHubEventIngestionService({
        database: { request } as never,
        repositories: [repository],
        policy,
        createSchedule,
        resolveConfiguration: () => configuration,
      });

      await expect(service.ingest(event)).rejects.toBeInstanceOf(
        GitHubRepositoryNotConfiguredError,
      );

      expect(createSchedule).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("resolves each event again so a paused repository continues observation without scheduling", async () => {
    const request = vi.fn();
    const createSchedule = vi.fn();
    const resolveConfiguration = vi
      .fn()
      .mockResolvedValueOnce(dynamicConfiguration)
      .mockResolvedValueOnce({
        ...dynamicConfiguration,
        allowScheduling: false,
        schedule: null,
      });
    const service = new GitHubEventIngestionService({
      database: { request } as never,
      repositories: [repository],
      policy,
      createSchedule,
      resolveConfiguration,
    });
    const nextEvent = { ...event, eventId: "event-2", sourceEventId: "source-2" };

    await service.ingest(event);
    await service.ingest(nextEvent);

    expect(resolveConfiguration).toHaveBeenNthCalledWith(1, event);
    expect(resolveConfiguration).toHaveBeenNthCalledWith(2, nextEvent);
    expect(createSchedule).not.toHaveBeenCalled();
    expect(request).toHaveBeenNthCalledWith(1, "ingestSchedulingEvent", {
      event,
      policy: dynamicPolicy,
      delivery: null,
      allowScheduling: true,
      schedule: dynamicSchedule,
    });
    expect(request).toHaveBeenNthCalledWith(2, "ingestSchedulingEvent", {
      event: nextEvent,
      policy: dynamicPolicy,
      delivery: null,
      allowScheduling: false,
      schedule: null,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects a paused configuration that still supplies a schedule before database access", async () => {
    const request = vi.fn();
    const createSchedule = vi.fn();
    const service = new GitHubEventIngestionService({
      database: { request } as never,
      repositories: [repository],
      policy,
      createSchedule,
      resolveConfiguration: () => ({ ...dynamicConfiguration, allowScheduling: false }),
    });

    await expect(service.ingest(event)).rejects.toThrow(
      "An observation-only repository cannot supply a job schedule.",
    );

    expect(createSchedule).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("propagates resolver failures instead of using bootstrap authorization or scheduling", async () => {
    const request = vi.fn();
    const createSchedule = vi.fn();
    const failure = new Error("Repository configuration is temporarily unavailable.");
    const service = new GitHubEventIngestionService({
      database: { request } as never,
      repositories: [repository],
      policy,
      createSchedule,
      resolveConfiguration: vi.fn().mockRejectedValue(failure),
    });

    await expect(service.ingest(event)).rejects.toBe(failure);

    expect(createSchedule).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
