import { createHmac } from "node:crypto";
import type { ManagedRepository, SelfOrAllowlistPolicy } from "@agentic-review/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../dist/app.js";
import type { ServerConfig } from "../../dist/config.js";
import { DatabaseRequestError } from "../../dist/database/errors.js";
import type { IngestSchedulingEventResult } from "../../dist/database/protocol.js";
import { GitHubEventIngestionService } from "../../dist/github/ingestion-service.js";
import { createSchedulingTestDatabase } from "../background/scheduling-pump.testing.js";

const webhookPath = "/api/v1/github/webhook";
const secret = "test-webhook-health-secret";
const deliveryId = "webhook-health-delivery-1";
const repository = { githubRepositoryId: 10, fullName: "microsoft/PowerToys" };
const policy: SelfOrAllowlistPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: 303,
  allowlistedActorGithubUserIds: [],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "inherit_authorized_epoch",
};
const managedRepository: ManagedRepository = {
  id: "repository-10",
  ...repository,
  enabled: true,
  version: 1,
  reviewerGithubUserId: 303,
  reviewerGithubLogin: "target",
  authorizationPolicy: policy,
  connectionStatus: "ready",
  connectionMessage: null,
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
};
const persistedResult: IngestSchedulingEventResult = {
  outcome: "processed",
  eventId: "event-1",
  repositoryId: managedRepository.id,
  workItemId: "work-item-123",
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
const config: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  recoveryMaintenance: false,
  databasePath: "unused.sqlite",
  migrationsDirectory: "unused",
  protocolVersion: "1.0",
  heartbeatIntervalSeconds: 20,
  leaseTtlSeconds: 120,
  leaseReaperIntervalSeconds: 3_600,
  operatorAuthCleanupIntervalSeconds: 3_600,
  operatorAuthCleanupBatchSize: 100,
  retryDelaySeconds: 1,
  workerOfflineAfterSeconds: 90,
  maxLongPollSeconds: 30,
  allowInsecureHttp: true,
  tls: undefined,
  github: {
    legacyBootstrap: undefined,
    promptDirectory: "unused/prompts",
    polling: undefined,
    webhook: { path: webhookPath, secret: Buffer.from(secret), maxPayloadBytes: 64 * 1_024 },
  },
  operatorAuth: undefined,
  dashboardDirectory: undefined,
};

const identity = (id: number, login: string) => ({ id, node_id: `U_${id}`, login, type: "User" });
const payloadFor = (target = repository) => {
  const [owner, name] = target.fullName.split("/");
  return {
    action: "assigned",
    issue: {
      id: 20,
      node_id: "I_20",
      number: 123,
      title: "Issue title",
      body: "Issue body",
      state: "open",
      html_url: `https://github.com/${target.fullName}/issues/123`,
      created_at: "2026-08-29T01:02:03Z",
      updated_at: "2026-08-30T01:02:03Z",
      closed_at: null,
      user: identity(101, "author"),
      assignee: identity(303, "target"),
      assignees: [identity(303, "target")],
    },
    assignee: identity(303, "target"),
    sender: identity(202, "scheduler"),
    repository: {
      id: target.githubRepositoryId,
      node_id: `R_${target.githubRepositoryId}`,
      name,
      full_name: target.fullName,
      html_url: `https://github.com/${target.fullName}`,
      default_branch: "main",
      private: false,
      owner: identity(1, owner ?? "owner"),
    },
  };
};
const signedHeaders = (body: string) => ({
  "content-type": "application/json",
  "x-github-delivery": deliveryId,
  "x-github-event": "issues",
  "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
});

const apps: FastifyInstance[] = [];
const createApp = (
  options: {
    readonly ingestionError?: Error;
    readonly lookupError?: Error;
    readonly lookupResult?: ManagedRepository | null;
  } = {},
) => {
  const persist = vi.fn(async () => {
    if (options.ingestionError !== undefined) throw options.ingestionError;
    return persistedResult;
  });
  const lookup = vi.fn(async () => {
    if (options.lookupError !== undefined) throw options.lookupError;
    return options.lookupResult === undefined ? managedRepository : options.lookupResult;
  });
  const request = vi.fn(async (operation: string) => {
    switch (operation) {
      case "cleanupExpiredOperatorAuth":
        return {
          deletedBrowserFlows: 0,
          deletedLoginTransactions: 0,
          deletedSessions: 0,
          hasMore: false,
        };
      case "reapExpiredLeases":
        return { expiredCount: 0 };
      case "ingestSchedulingEvent":
        return persist();
      case "getManagedRepositoryByGitHubId":
        return lookup();
      default:
        throw new Error(`Unexpected database operation: ${operation}`);
    }
  });
  const database = createSchedulingTestDatabase(request);
  const resolveConfiguration = vi.fn(async (event: { repository: typeof repository }) =>
    event.repository.githubRepositoryId === repository.githubRepositoryId &&
    event.repository.fullName.toLowerCase() === repository.fullName.toLowerCase()
      ? { repository, policy, allowScheduling: false, schedule: null }
      : null,
  );
  const githubIngestion = new GitHubEventIngestionService({ database, resolveConfiguration });
  const health = { recordWebhookSuccess: vi.fn(), recordWebhookFailure: vi.fn() };
  const app = buildApp({
    config,
    database,
    githubIngestion,
    githubWebhookHealth: health,
    shutdownSignal: new AbortController().signal,
    serverAdmission: { read: () => true },
  });
  app.log.level = "silent";
  apps.push(app);
  return { app, health, persist, lookup, request, resolveConfiguration };
};

const deliver = (app: FastifyInstance, target = repository) => {
  const body = JSON.stringify(payloadFor(target));
  return app.inject({
    method: "POST",
    url: webhookPath,
    headers: signedHeaders(body),
    payload: body,
  });
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("GitHub webhook application health observations", () => {
  it("records success after persisting a signed delivery for a dynamically configured repository", async () => {
    const { app, health, persist, lookup } = createApp();
    const response = await deliver(app);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted", deliveryId });
    expect(persist).toHaveBeenCalledOnce();
    expect(health.recordWebhookSuccess).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(repository),
    );
    expect(health.recordWebhookSuccess.mock.invocationCallOrder[0]).toBeGreaterThan(
      persist.mock.invocationCallOrder[0] ?? 0,
    );
    expect(health.recordWebhookFailure).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does not observe unauthenticated deliveries", async () => {
    const { app, health, persist, lookup, resolveConfiguration } = createApp();
    const body = JSON.stringify(payloadFor());
    const response = await app.inject({
      method: "POST",
      url: webhookPath,
      headers: { ...signedHeaders(body), "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
      payload: body,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "invalid_github_webhook_signature" });
    expect(resolveConfiguration).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(health.recordWebhookSuccess).not.toHaveBeenCalled();
    expect(health.recordWebhookFailure).not.toHaveBeenCalled();
  });

  it("does not pollute health when a signed delivery names an unconfigured repository", async () => {
    const { app, health, persist, lookup, resolveConfiguration } = createApp();
    const response = await deliver(app, { githubRepositoryId: 11, fullName: "other/project" });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "github_repository_not_configured" });
    expect(resolveConfiguration).toHaveBeenCalledOnce();
    expect(persist).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(health.recordWebhookSuccess).not.toHaveBeenCalled();
    expect(health.recordWebhookFailure).not.toHaveBeenCalled();
  });

  it("records a configured repository's processing failure while preserving the original HTTP error", async () => {
    const ingestionError = new DatabaseRequestError(
      "Delivery content conflicts with the saved delivery.",
      "WEBHOOK_DELIVERY_CONFLICT",
    );
    const { app, health, persist, lookup, request } = createApp({
      ingestionError,
      lookupResult: { ...managedRepository, fullName: "MICROSOFT/POWERTOYS" },
    });
    const response = await deliver(app);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "webhook_delivery_conflict",
      message: ingestionError.message,
      retryable: false,
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("getManagedRepositoryByGitHubId", {
      githubRepositoryId: repository.githubRepositoryId,
    });
    expect(health.recordWebhookFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(repository),
    );
    expect(health.recordWebhookSuccess).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing repository", lookupResult: null },
    {
      name: "repository name mismatch",
      lookupResult: { ...managedRepository, fullName: "other/project" },
    },
    {
      name: "repository lookup failure",
      lookupError: new Error("Lookup database is unavailable."),
    },
  ])("preserves ingestion errors without recording a failure for $name", async (lookupOptions) => {
    const ingestionError = new DatabaseRequestError(
      "The normalized delivery conflicts with stored history.",
      "NORMALIZED_EVENT_CONFLICT",
    );
    const { app, health, lookup } = createApp({ ...lookupOptions, ingestionError });
    const response = await deliver(app);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "normalized_event_conflict",
      message: ingestionError.message,
      retryable: false,
    });
    expect(lookup).toHaveBeenCalledOnce();
    expect(health.recordWebhookSuccess).not.toHaveBeenCalled();
    expect(health.recordWebhookFailure).not.toHaveBeenCalled();
  });
});
