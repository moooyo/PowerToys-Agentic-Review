import { setTimeout as delay } from "node:timers/promises";
import {
  IssueTriageV1ModelOutputSchema,
  PrReviewPlanV1ModelOutputSchema,
} from "@agentic-review/codex";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { DatabaseGitHubPollingState } from "./database/github-polling-state.js";
import { DatabaseOperatorAuthPersistence } from "./database/operator-auth-persistence.js";
import { GitHubEventIngestionService } from "./github/ingestion-service.js";
import { GitHubPollingCoordinator } from "./github/polling-coordinator.js";
import { GitHubRestApiError, GitHubRestClient } from "./github/rest-client.js";
import { createProductionServerLifecycle } from "./runtime/server-lifecycle.js";
import { createServerStorageRuntime } from "./runtime/server-storage-runtime.js";
import {
  createScheduleJobInput,
  defaultTrustedSchedulingPolicy,
  loadTrustedSchedulingConfig,
} from "./scheduling/index.js";
import { OperatorAuthService } from "./security/operator-auth.js";
import { createOperatorOidcClient } from "./security/operator-auth-oidc.js";

const serverShutdownTimeoutMilliseconds = 120_000;

const normalizeFailure = (error: unknown): Error =>
  error instanceof Error
    ? error
    : new Error("The server received a non-Error lifecycle failure.", { cause: error });

const start = async (): Promise<void> => {
  const lifecycle = createProductionServerLifecycle({
    shutdownTimeoutMilliseconds: serverShutdownTimeoutMilliseconds,
  });
  let running = false;
  let artifactFailStopLogged = false;

  const requestSigintShutdown = (): void => lifecycle.requestGracefulShutdown("SIGINT");
  const requestSigtermShutdown = (): void => lifecycle.requestGracefulShutdown("SIGTERM");
  process.on("SIGINT", requestSigintShutdown);
  process.on("SIGTERM", requestSigtermShutdown);

  try {
    const config = loadConfig();
    const operatorAuthConfig = config.operatorAuth;
    const oidc =
      operatorAuthConfig?.oidc === undefined
        ? undefined
        : await createOperatorOidcClient(operatorAuthConfig.oidc);
    lifecycle.signal.throwIfAborted();

    const schedulingConfig =
      config.github === undefined
        ? undefined
        : await loadTrustedSchedulingConfig({
            promptDirectory: config.github.promptDirectory,
            policy: defaultTrustedSchedulingPolicy,
            outputSchemas: {
              issueTriage: IssueTriageV1ModelOutputSchema,
              pullRequestReview: PrReviewPlanV1ModelOutputSchema,
            },
          });
    lifecycle.signal.throwIfAborted();

    const storageRuntime = await createServerStorageRuntime({
      databasePath: config.databasePath,
      migrationsDirectory: config.migrationsDirectory,
      artifactStorage: config.artifactStorage,
      onFailStop: (error) => {
        lifecycle.onArtifactFailStop(error);
        if (!artifactFailStopLogged) {
          artifactFailStopLogged = true;
          try {
            console.error(
              JSON.stringify({
                timestamp: new Date().toISOString(),
                level: "fatal",
                message: "Artifact storage requested a fail-stop.",
                code: error.code,
              }),
            );
          } catch {
            // Logging failure cannot delay process-wide fail-stop.
          }
        }
      },
    });
    lifecycle.adoptStorageRuntime(storageRuntime);
    lifecycle.signal.throwIfAborted();

    const database = storageRuntime.database;
    const operatorAuth =
      operatorAuthConfig === undefined
        ? undefined
        : new OperatorAuthService({
            config: operatorAuthConfig.service,
            persistence: new DatabaseOperatorAuthPersistence(database),
            ...(oidc === undefined ? {} : { oidc }),
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
      shutdownSignal: lifecycle.signal,
      artifactReadiness: storageRuntime.artifactReadiness,
      artifactTransactions: storageRuntime.artifactTransactions,
      serverAdmission: lifecycle.admission,
      ...(githubIngestion === undefined ? {} : { githubIngestion }),
      ...(operatorAuth === undefined ? {} : { operatorAuth }),
    });
    lifecycle.adoptApplication(app);
    lifecycle.signal.throwIfAborted();

    await app.listen({ host: config.host, port: config.port });
    lifecycle.signal.throwIfAborted();

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
              await delay(waitMs, undefined, { signal: lifecycle.signal });
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
        signal: lifecycle.signal,
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
      const pollingCompletion = pollingCoordinator.run().catch((error: unknown) => {
        app.log.error({ error }, "GitHub polling coordinator stopped unexpectedly.");
        throw error;
      });
      lifecycle.trackBackground("github-polling", pollingCompletion);
    }

    lifecycle.signal.throwIfAborted();
    lifecycle.markRunning();
    running = true;
    app.log.info(
      {
        host: config.host,
        port: config.port,
        databasePath: config.databasePath,
        protocolVersion: config.protocolVersion,
      },
      "Agentic Review server is ready.",
    );
    await lifecycle.completion;
  } catch (error) {
    const startupWasStopped =
      !running && lifecycle.signal.aborted && error === lifecycle.signal.reason;
    if (startupWasStopped) {
      if (!artifactFailStopLogged) {
        console.info(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "info",
            message: "Agentic Review server startup was stopped.",
          }),
        );
      }
    } else {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "fatal",
          message: running
            ? "Agentic Review server failed while running."
            : "Agentic Review server failed to start.",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    if (running) {
      lifecycle.onArtifactFailStop(normalizeFailure(error));
    } else if (startupWasStopped) {
      lifecycle.sealStartupShutdown();
    } else {
      lifecycle.sealStartupFailure(error);
    }
    await lifecycle.completion;
  } finally {
    process.off("SIGINT", requestSigintShutdown);
    process.off("SIGTERM", requestSigtermShutdown);
  }
};

await start();
