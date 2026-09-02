import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { ArtifactTransactionPort } from "./artifacts/index.js";
import { startLeaseReaper } from "./background/lease-reaper.js";
import { startOperatorAuthReaper } from "./background/operator-auth-reaper.js";
import type { ServerConfig } from "./config.js";
import type { DatabaseClient } from "./database/database-client.js";
import { DatabaseRequestError } from "./database/errors.js";
import {
  type GitHubEventIngestionService,
  GitHubRepositoryNotConfiguredError,
} from "./github/ingestion-service.js";
import {
  type OperatorAuthRouteService,
  readOperatorSession,
  registerOperatorAuthRoutes,
} from "./routes/auth.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerGitHubWebhookRoutes } from "./routes/github.js";
import { type ArtifactReadinessProbe, registerHealthRoutes } from "./routes/health.js";
import { registerWorkerArtifactRoutes } from "./routes/worker-artifacts.js";
import { registerWorkerRoutes } from "./routes/workers.js";

export interface AppDependencies {
  readonly config: ServerConfig;
  readonly database: DatabaseClient;
  readonly shutdownSignal: AbortSignal;
  readonly artifactReadiness: ArtifactReadinessProbe;
  readonly artifactTransactions: ArtifactTransactionPort;
  readonly serverAdmission: {
    read(): boolean;
  };
  readonly githubIngestion?: GitHubEventIngestionService;
  readonly operatorAuth?: OperatorAuthRouteService;
}

const isRequestValidationError = (
  error: unknown,
): error is Error & { readonly validation: unknown } =>
  error instanceof Error && "validation" in error && error.validation !== undefined;

export const buildApp = (dependencies: AppDependencies): FastifyInstance => {
  if (dependencies.config.tls === undefined && !dependencies.config.allowInsecureWorkerAuth) {
    throw new Error(
      "Worker authentication is fail-closed: configure TLS or explicitly enable loopback-only insecure development mode.",
    );
  }

  const app = Fastify({
    logger: {
      level: process.env.AGENTIC_REVIEW_LOG_LEVEL ?? "info",
    },
    bodyLimit: 2 * 1_024 * 1_024,
    requestTimeout: 40_000,
    ...(dependencies.config.tls === undefined ? {} : { https: dependencies.config.tls }),
  });

  if (dependencies.config.allowInsecureWorkerAuth) {
    app.log.warn("Worker mTLS authentication is disabled for loopback-only development.");
  }

  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" && request.url === "/health/live") {
      return;
    }
    let admitted = false;
    try {
      admitted = dependencies.serverAdmission.read() === true;
    } catch {
      admitted = false;
    }
    if (!admitted) {
      return reply.code(503).send({
        status: "not_ready",
        serverTime: new Date().toISOString(),
      });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof Error && "code" in error && error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send({
        code: "request_body_too_large",
        message: "The request body exceeds the configured limit.",
        retryable: false,
      });
    }
    if (error instanceof DatabaseRequestError && error.code === "LEASE_LOST") {
      return reply.code(409).send({
        code: "lease_lost",
        message: error.message,
        retryable: false,
      });
    }
    if (error instanceof DatabaseRequestError && error.code === "RESULT_DIGEST_MISMATCH") {
      return reply.code(400).send({
        code: "result_digest_mismatch",
        message: error.message,
        retryable: false,
      });
    }
    if (
      error instanceof DatabaseRequestError &&
      (error.code === "REVIEW_RESULT_INVALID" || error.code === "STORED_EXECUTION_TEMPLATE_INVALID")
    ) {
      return reply.code(422).send({
        code: error.code.toLowerCase(),
        message: error.message,
        retryable: false,
      });
    }
    if (error instanceof DatabaseRequestError && error.code === "WORKER_UNAVAILABLE") {
      return reply.code(409).send({
        code: "worker_unavailable",
        message: error.message,
        retryable: true,
      });
    }
    if (error instanceof DatabaseRequestError && error.code === "WORKER_INSTANCE_SUPERSEDED") {
      return reply.code(409).send({
        code: "worker_instance_superseded",
        message: error.message,
        retryable: false,
      });
    }
    if (
      error instanceof DatabaseRequestError &&
      (error.code === "WEBHOOK_DELIVERY_CONFLICT" || error.code === "NORMALIZED_EVENT_CONFLICT")
    ) {
      return reply.code(409).send({
        code: error.code.toLowerCase(),
        message: error.message,
        retryable: false,
      });
    }
    if (
      error instanceof DatabaseRequestError &&
      error.code === "GITHUB_INGESTION_INVARIANT_VIOLATION"
    ) {
      return reply.code(422).send({
        code: error.code.toLowerCase(),
        message: error.message,
        retryable: false,
      });
    }
    if (error instanceof GitHubRepositoryNotConfiguredError) {
      return reply.code(403).send({
        code: error.code.toLowerCase(),
        message: error.message,
        retryable: false,
      });
    }
    if (isRequestValidationError(error)) {
      return reply.code(400).send({
        code: "request_validation_failed",
        message: error.message,
        retryable: false,
      });
    }

    app.log.error({ error }, "Unhandled request error.");
    return reply.code(500).send({
      code: "internal_error",
      message: "The server could not complete the request.",
      retryable: true,
    });
  });

  registerHealthRoutes(
    app,
    dependencies.database,
    dependencies.artifactReadiness,
    dependencies.shutdownSignal,
  );
  registerWorkerRoutes(app, dependencies);
  registerWorkerArtifactRoutes(app, {
    config: dependencies.config,
    transactions: dependencies.artifactTransactions,
    shutdownSignal: dependencies.shutdownSignal,
  });

  const operatorAuth = dependencies.operatorAuth;
  if (operatorAuth !== undefined) {
    registerOperatorAuthRoutes(app, operatorAuth);
    registerDashboardRoutes(app, {
      database: dependencies.database,
      authenticate: async (request, reply) => {
        reply.header("cache-control", "private, no-store").header("vary", "Cookie");
        const session = await readOperatorSession(request, operatorAuth);
        if (session === null) {
          return reply.code(401).send({
            code: "operator_authentication_required",
            message: "An authenticated operator session is required.",
            retryable: false,
          });
        }
      },
    });
  }

  const webhook = dependencies.config.github?.webhook;
  if (webhook !== undefined) {
    const githubIngestion = dependencies.githubIngestion;
    if (githubIngestion === undefined) {
      throw new Error("GitHub webhook configuration requires an ingestion service.");
    }
    registerGitHubWebhookRoutes(app, {
      config: {
        path: webhook.path,
        webhookSecret: webhook.secret,
        maxPayloadBytes: webhook.maxPayloadBytes,
      },
      ingest: async (event, delivery) => {
        await githubIngestion.ingest(event, delivery);
      },
    });
  }

  if (dependencies.config.dashboardDirectory !== undefined) {
    app.register(fastifyStatic, {
      root: dependencies.config.dashboardDirectory,
      prefix: "/",
      decorateReply: true,
    });
    app.setNotFoundHandler(async (request, reply) => {
      const acceptsHtml = request.headers.accept?.includes("text/html") === true;
      if (request.method === "GET" && acceptsHtml && !request.url.startsWith("/api/")) {
        return reply.sendFile("index.html", { cacheControl: false });
      }
      return reply.code(404).send({
        code: "not_found",
        message: "The requested resource was not found.",
        retryable: false,
      });
    });
  }

  const stopLeaseReaper = startLeaseReaper(
    dependencies.database,
    dependencies.config,
    app.log,
    dependencies.shutdownSignal,
  );
  const stopOperatorAuthReaper = startOperatorAuthReaper(
    dependencies.database,
    dependencies.config,
    app.log,
    dependencies.shutdownSignal,
  );
  app.addHook("onClose", async () => {
    await Promise.all([stopLeaseReaper(), stopOperatorAuthReaper()]);
  });

  return app;
};
