import { setTimeout as delay } from "node:timers/promises";
import {
  IssueTriageV2ModelOutputSchema,
  PrReviewPlanV2ModelOutputSchema,
} from "@agentic-review/codex";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { DatabaseGitHubPollingState } from "./database/github-polling-state.js";
import { DatabaseOperatorAuthPersistence } from "./database/operator-auth-persistence.js";
import { createGitHubIngestionHealthTracker } from "./github/ingestion-health.js";
import { GitHubEventIngestionService } from "./github/ingestion-service.js";
import { GitHubPollingCoordinator } from "./github/polling-coordinator.js";
import { GitHubPublicationClient } from "./github/publication-client.js";
import { GitHubRestApiError, GitHubRestClient } from "./github/rest-client.js";
import { ManagedGitHubRuntimeConfiguration } from "./runtime/managed-github-configuration.js";
import { createProductionServerLifecycle } from "./runtime/server-lifecycle.js";
import { assertLinuxServerPlatform } from "./runtime/server-platform.js";
import {
  createRecoveryMaintenanceStorageRuntime,
  createServerStorageRuntime,
} from "./runtime/server-storage-runtime.js";
import { defaultTrustedSchedulingPolicy, loadTrustedSchedulingConfig } from "./scheduling/index.js";
import { OperatorAuthService } from "./security/operator-auth.js";
import { createOperatorOidcClient } from "./security/operator-auth-oidc.js";

const serverShutdownTimeoutMilliseconds = 120_000;

const normalizeFailure = (error: unknown): Error =>
  error instanceof Error
    ? error
    : new Error("The server received a non-Error lifecycle failure.", { cause: error });

const summarizeGitHubPollingError = (
  error: unknown,
  token: string,
): { name: string; message: string } => {
  if (!(error instanceof Error)) {
    return {
      name: "UnknownError",
      message: "The GitHub polling operation received a non-Error failure.",
    };
  }
  const sanitize = (value: string, maximumLength: number): string =>
    value
      .replaceAll(token, "[REDACTED]")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip control characters from untrusted diagnostic text.
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .slice(0, maximumLength);
  return {
    name: sanitize(error.name, 128),
    message: sanitize(error.message, 2_048),
  };
};

const start = async (): Promise<void> => {
  assertLinuxServerPlatform();
  const lifecycle = createProductionServerLifecycle({
    shutdownTimeoutMilliseconds: serverShutdownTimeoutMilliseconds,
  });
  let running = false;

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
      config.recoveryMaintenance || config.github === undefined
        ? undefined
        : await loadTrustedSchedulingConfig({
            promptDirectory: config.github.promptDirectory,
            policy: defaultTrustedSchedulingPolicy,
            outputSchemas: {
              issueTriage: IssueTriageV2ModelOutputSchema,
              pullRequestReview: PrReviewPlanV2ModelOutputSchema,
            },
          });
    lifecycle.signal.throwIfAborted();

    const storageRuntime = config.recoveryMaintenance
      ? await createRecoveryMaintenanceStorageRuntime({
          databasePath: config.databasePath,
          migrationsDirectory: config.migrationsDirectory,
          ...(config.operatorAccess === undefined ? {} : { operatorAccess: config.operatorAccess }),
          ...(config.evidenceStorage === undefined
            ? {}
            : { evidenceStorage: config.evidenceStorage }),
        })
      : await createServerStorageRuntime({
          databasePath: config.databasePath,
          migrationsDirectory: config.migrationsDirectory,
          ...(config.publication === undefined
            ? {}
            : { publicationPublisher: { githubUserId: config.publication.githubUserId } }),
          ...(config.operatorAccess === undefined ? {} : { operatorAccess: config.operatorAccess }),
          ...(config.evidenceStorage === undefined
            ? {}
            : { evidenceStorage: config.evidenceStorage }),
        });
    lifecycle.adoptStorageRuntime(storageRuntime);
    lifecycle.signal.throwIfAborted();

    const database = storageRuntime.database;
    if (config.recoveryMaintenance) {
      await database.request("purgeOperatorAuthForRecovery", {});
      lifecycle.signal.throwIfAborted();
    }
    if (
      !config.recoveryMaintenance &&
      config.github !== undefined &&
      schedulingConfig !== undefined
    ) {
      if (config.github.legacyBootstrap !== undefined) {
        await database.request("bootstrapManagedRepositories", config.github.legacyBootstrap);
      }
      await database.request("bootstrapPromptTemplates", {
        actor: { issuer: "system", subject: "trusted-file-bootstrap" },
        templates: [
          {
            name: "Default PR review",
            workflowKind: "pr_static_build",
            content: schedulingConfig.pullRequestReview.text,
            outputSchemaVersion: "PrReviewPlanV2",
          },
          {
            name: "Default issue triage",
            workflowKind: "issue_triage",
            content: schedulingConfig.issueTriage.text,
            outputSchemaVersion: "IssueTriageV2",
          },
        ],
      });
      lifecycle.signal.throwIfAborted();
    }
    const managedGitHub =
      schedulingConfig === undefined
        ? undefined
        : new ManagedGitHubRuntimeConfiguration({
            database,
            legacySchedulingConfig: schedulingConfig,
          });
    const operatorAuth =
      operatorAuthConfig === undefined
        ? undefined
        : new OperatorAuthService({
            config: operatorAuthConfig.service,
            persistence: new DatabaseOperatorAuthPersistence(database),
            ...(oidc === undefined ? {} : { oidc }),
          });
    const githubIngestion =
      config.recoveryMaintenance || managedGitHub === undefined
        ? undefined
        : new GitHubEventIngestionService({
            database,
            resolveConfiguration: (event) => managedGitHub.resolveEvent(event),
          });
    const githubHealth = createGitHubIngestionHealthTracker(config);
    const app = buildApp({
      config,
      database,
      githubHealth,
      githubWebhookHealth: githubHealth,
      shutdownSignal: lifecycle.signal,
      serverAdmission: lifecycle.admission,
      ...(githubIngestion === undefined ? {} : { githubIngestion }),
      ...(operatorAuth === undefined ? {} : { operatorAuth }),
      ...(config.publication === undefined
        ? {}
        : {
            publicationTransport: new GitHubPublicationClient({
              token: config.publication.token,
              expectedGitHubUserId: config.publication.githubUserId,
            }),
          }),
    });
    lifecycle.adoptApplication(app);
    lifecycle.signal.throwIfAborted();

    await app.listen({ host: config.host, port: config.port });
    lifecycle.signal.throwIfAborted();

    const pollingConfig = config.github?.polling;
    if (
      pollingConfig !== undefined &&
      !config.recoveryMaintenance &&
      config.github !== undefined &&
      githubIngestion !== undefined &&
      managedGitHub !== undefined
    ) {
      const pollingState = new DatabaseGitHubPollingState(database);
      const pollingCoordinator = new GitHubPollingCoordinator({
        client: new GitHubRestClient({
          token: pollingConfig.token,
          userAgent: "Agentic-Review/0.1.0",
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
        resolveTargets: async () => {
          const targets = await managedGitHub.listPollingTargets();
          githubHealth.updatePollingTargets(targets);
          return targets;
        },
        intervalMs: pollingConfig.intervalSeconds * 1_000,
        stateSource: pollingState,
        commitReconciliation: async (key, events, projection, signal) => {
          await pollingState.commitReconciliation(
            key,
            projection,
            await managedGitHub.prepareReconciliation(key, events),
            signal,
          );
          githubHealth.recordReconciliationSuccess(
            {
              githubRepositoryId: key.githubRepositoryId,
              fullName: key.repositoryFullName,
            },
            key.reviewerGithubUserId,
          );
        },
        signal: lifecycle.signal,
        observeError: (error, context) => {
          githubHealth.recordReconciliationFailure(
            context.repository,
            context.reviewer.githubUserId,
          );
          app.log.error(
            {
              error: summarizeGitHubPollingError(error, pollingConfig.token),
              repository: context.repository.fullName,
            },
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
        app.log.error(
          { error: summarizeGitHubPollingError(error, pollingConfig.token) },
          "GitHub polling coordinator stopped unexpectedly.",
        );
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
        recoveryMaintenance: config.recoveryMaintenance,
      },
      "Agentic Review server is ready.",
    );
    await lifecycle.completion;
  } catch (error) {
    const startupWasStopped =
      !running && lifecycle.signal.aborted && error === lifecycle.signal.reason;
    if (startupWasStopped) {
      console.info(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "info",
          message: "Agentic Review server startup was stopped.",
        }),
      );
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
      lifecycle.onFatalError(normalizeFailure(error));
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
