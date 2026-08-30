import { setTimeout as delay } from "node:timers/promises";
import { IssueTriageV1Schema, PrReviewPlanV1Schema } from "@agentic-review/codex";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { DatabaseClient } from "./database/database-client.js";
import { DatabaseGitHubPollingState } from "./database/github-polling-state.js";
import { DatabaseOperatorAuthPersistence } from "./database/operator-auth-persistence.js";
import { DatabaseOwnerLock } from "./database/owner-lock.js";
import { GitHubEventIngestionService } from "./github/ingestion-service.js";
import { GitHubPollingCoordinator } from "./github/polling-coordinator.js";
import { GitHubRestApiError, GitHubRestClient } from "./github/rest-client.js";
import {
  createScheduleJobInput,
  defaultTrustedSchedulingPolicy,
  loadTrustedSchedulingConfig,
} from "./scheduling/index.js";
import { OperatorAuthService } from "./security/operator-auth.js";
import { createOperatorOidcClient } from "./security/operator-auth-oidc.js";

const start = async (): Promise<void> => {
  const config = loadConfig();
  const shutdownController = new AbortController();
  let database: DatabaseClient | undefined;
  let databaseOwnerLock: DatabaseOwnerLock | undefined;
  let pollingPromise: Promise<void> | undefined;
  let application: { close(): Promise<void> } | undefined;

  const closeStorage = async (): Promise<void> => {
    try {
      await database?.close();
    } finally {
      await databaseOwnerLock?.close();
    }
  };

  try {
    databaseOwnerLock = await DatabaseOwnerLock.acquire(config.databasePath);
    database = await DatabaseClient.create({
      databasePath: config.databasePath,
      migrationsDirectory: config.migrationsDirectory,
    });
    const operatorAuthConfig = config.operatorAuth;
    const oidc =
      operatorAuthConfig?.oidc === undefined
        ? undefined
        : await createOperatorOidcClient(operatorAuthConfig.oidc);
    const operatorAuth =
      operatorAuthConfig === undefined
        ? undefined
        : new OperatorAuthService({
            config: operatorAuthConfig.service,
            persistence: new DatabaseOperatorAuthPersistence(database),
            ...(oidc === undefined ? {} : { oidc }),
          });
    const schedulingConfig =
      config.github === undefined
        ? undefined
        : await loadTrustedSchedulingConfig({
            promptDirectory: config.github.promptDirectory,
            policy: defaultTrustedSchedulingPolicy,
            outputSchemas: {
              issueTriage: IssueTriageV1Schema,
              pullRequestReview: PrReviewPlanV1Schema,
            },
          });
    const githubIngestion =
      config.github === undefined || schedulingConfig === undefined
        ? undefined
        : new GitHubEventIngestionService({
            database,
            repositories: config.github.repositories,
            policy: config.github.authorizationPolicy,
            createSchedule: (event) => createScheduleJobInput(event, schedulingConfig),
          });
    const app = buildApp({
      config,
      database,
      shutdownSignal: shutdownController.signal,
      ...(githubIngestion === undefined ? {} : { githubIngestion }),
      ...(operatorAuth === undefined ? {} : { operatorAuth }),
    });
    application = app;
    let shutdownPromise: Promise<void> | undefined;

    const shutdown = (signal: string): Promise<void> => {
      shutdownPromise ??= (async () => {
        app.log.info({ signal }, "Server shutdown started.");
        shutdownController.abort(new Error(`Received ${signal}.`));
        try {
          await Promise.all([app.close(), pollingPromise ?? Promise.resolve()]);
        } finally {
          await closeStorage();
        }
        app.log.info("Server shutdown completed.");
      })().catch((error: unknown) => {
        app.log.error({ error }, "Server shutdown failed.");
        process.exitCode = 1;
      });
      return shutdownPromise;
    };

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));

    await app.listen({ host: config.host, port: config.port });
    const pollingConfig = config.github?.polling;
    if (
      pollingConfig !== undefined &&
      config.github !== undefined &&
      githubIngestion !== undefined &&
      schedulingConfig !== undefined
    ) {
      const pollingState = new DatabaseGitHubPollingState(database);
      const githubConfig = config.github;
      const pollingCoordinator = new GitHubPollingCoordinator({
        client: new GitHubRestClient({
          token: pollingConfig.token,
          userAgent: "PowerToys-Agentic-Review/0.1.0",
          requestTimeoutMs: 30_000,
          observeResponse: async (observation) => {
            const rateLimit = observation.rateLimit;
            if (rateLimit === undefined) {
              return;
            }
            const untilResetMs = Math.max(0, Date.parse(rateLimit.resetAt) - Date.now() + 1_000);
            const waitMs =
              (rateLimit.retryAfterMs === undefined
                ? undefined
                : Math.min(rateLimit.retryAfterMs, 15 * 60 * 1_000)) ??
              (rateLimit.remaining === 0
                ? Math.min(untilResetMs, 15 * 60 * 1_000)
                : rateLimit.resource === "search" && rateLimit.remaining < 3
                  ? Math.min(untilResetMs, 5_000)
                  : 0);
            if (rateLimit.remaining < 100) {
              app.log.warn(
                {
                  resource: rateLimit.resource,
                  remaining: rateLimit.remaining,
                  resetAt: rateLimit.resetAt,
                  waitMs,
                },
                "GitHub REST rate limit is low.",
              );
            }
            if (waitMs > 0) {
              await delay(waitMs, undefined, { signal: shutdownController.signal });
            }
          },
        }),
        repositories: config.github.repositories,
        reviewer: config.github.reviewer,
        intervalMs: pollingConfig.intervalSeconds * 1_000,
        stateSource: pollingState,
        commitReconciliation: async (key, events, projection, signal) => {
          await pollingState.commitReconciliation(
            key,
            projection,
            events.map((event) => ({
              event,
              policy: githubConfig.authorizationPolicy,
              schedule: createScheduleJobInput(event, schedulingConfig),
            })),
            signal,
          );
        },
        signal: shutdownController.signal,
        observeError: (error, context) => {
          app.log.error(
            { error, repository: context.repository.fullName },
            "GitHub polling reconciliation failed for a repository.",
          );
        },
        isPermanentlyUnavailableWorkItem: (error) =>
          error instanceof GitHubRestApiError && (error.status === 404 || error.status === 410),
        observeUnavailableWorkItems: (workItemNumbers, context) => {
          app.log.warn(
            { repository: context.repository.fullName, workItemNumbers },
            "Historical GitHub work items are temporarily unavailable; their prior reconciliation state was preserved.",
          );
        },
      });
      pollingPromise = pollingCoordinator.run().catch((error: unknown) => {
        if (!shutdownController.signal.aborted) {
          app.log.error({ error }, "GitHub polling coordinator stopped unexpectedly.");
          process.exitCode = 1;
          setImmediate(() => void shutdown("GITHUB_POLLING_FAILURE"));
        }
      });
    }
    app.log.info(
      {
        host: config.host,
        port: config.port,
        databasePath: config.databasePath,
        protocolVersion: config.protocolVersion,
      },
      "Agentic Review server is ready.",
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "fatal",
        message: "Agentic Review server failed to start.",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    shutdownController.abort(error);
    await application?.close().catch(() => undefined);
    await pollingPromise?.catch(() => undefined);
    await closeStorage().catch(() => undefined);
    process.exitCode = 1;
  }
};

await start();
