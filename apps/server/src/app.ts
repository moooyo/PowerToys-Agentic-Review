import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
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
import { registerHealthRoutes } from "./routes/health.js";
import { registerWorkerCredentialRoutes } from "./routes/worker-credentials.js";
import { registerWorkerRoutes } from "./routes/workers.js";

export interface AppDependencies {
  readonly config: ServerConfig;
  readonly database: DatabaseClient;
  readonly shutdownSignal: AbortSignal;
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

const workerTokenInPath = /arw1_[A-Za-z0-9_-]{43}/gu;
const operatorWorkerCredentialRequestsPerMinute = 300;
const redactWorkerTokens = (value: string): string =>
  value.replace(workerTokenInPath, "[REDACTED]");

const isWorkerApiRoute = (routeUrl: string | undefined): boolean =>
  routeUrl === "/api/v1/worker" || routeUrl?.startsWith("/api/v1/worker/") === true;

const sendWorkerApiMaintenance = (reply: FastifyReply): FastifyReply =>
  reply.code(503).send({
    code: "worker_api_maintenance",
    message: "Worker API access is disabled during recovery maintenance.",
    retryable: true,
  });

export const sanitizeRequestLogUrl = (url: string | undefined): string =>
  redactWorkerTokens((url ?? "").split("?", 1)[0] ?? "");

export const buildApp = (dependencies: AppDependencies): FastifyInstance => {
  if (dependencies.config.tls === undefined && !dependencies.config.allowInsecureHttp) {
    throw new Error(
      "Server transport is fail-closed: configure TLS or explicitly enable loopback development HTTP.",
    );
  }

  const app = Fastify({
    logger: {
      level: process.env.AGENTIC_REVIEW_LOG_LEVEL ?? "info",
      redact: {
        paths: ["req.headers.authorization"],
        censor: "[REDACTED]",
      },
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: sanitizeRequestLogUrl(request.url),
            ...(request.headers.host === undefined
              ? {}
              : { host: redactWorkerTokens(request.headers.host) }),
            ...(request.socket.remoteAddress === undefined
              ? {}
              : { remoteAddress: request.socket.remoteAddress }),
          };
        },
      },
    },
    bodyLimit: 2 * 1_024 * 1_024,
    requestTimeout: 40_000,
    ...(dependencies.config.tls === undefined ? {} : { https: dependencies.config.tls }),
  });

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
    if (dependencies.config.recoveryMaintenance && isWorkerApiRoute(request.routeOptions.url)) {
      return sendWorkerApiMaintenance(reply);
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof Error && "statusCode" in error && error.statusCode === 429) {
      return reply.code(429).send({
        code: "request_rate_limited",
        message: "Too many requests were received. Retry later.",
        retryable: true,
      });
    }
    if (error instanceof Error && "code" in error && error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send({
        code: "request_body_too_large",
        message: "The request body exceeds the configured limit.",
        retryable: false,
      });
    }
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
        error.code === "FST_ERR_CTP_EMPTY_JSON_BODY")
    ) {
      return reply.code(400).send({
        code: "request_validation_failed",
        message: "The request body is not valid JSON.",
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
    dependencies.serverAdmission,
    dependencies.config.recoveryMaintenance,
  );
  app.register(async (workerScope) => {
    workerScope.addHook("onRequest", async (_request, reply) => {
      if (dependencies.config.recoveryMaintenance) {
        return sendWorkerApiMaintenance(reply);
      }
    });
    await workerScope.register(rateLimit, {
      global: false,
      max: 600,
      timeWindow: "1 minute",
    });
    workerScope.addHook("onRequest", workerScope.rateLimit({ max: 600, timeWindow: "1 minute" }));
    registerWorkerRoutes(workerScope, {
      config: dependencies.config,
      database: dependencies.database,
      shutdownSignal: dependencies.shutdownSignal,
    });
  });

  const operatorAuth = dependencies.operatorAuth;
  if (operatorAuth !== undefined) {
    registerOperatorAuthRoutes(app, operatorAuth);
    app.register(async (credentialScope) => {
      await credentialScope.register(rateLimit, {
        global: false,
        max: operatorWorkerCredentialRequestsPerMinute,
        timeWindow: "1 minute",
      });
      credentialScope.addHook(
        "onRequest",
        credentialScope.rateLimit({
          max: operatorWorkerCredentialRequestsPerMinute,
          timeWindow: "1 minute",
        }),
      );
      registerWorkerCredentialRoutes(credentialScope, {
        database: dependencies.database,
        operatorAuth,
      });
    });
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

  const webhook = dependencies.config.recoveryMaintenance
    ? undefined
    : dependencies.config.github?.webhook;
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

  const stopLeaseReaper = dependencies.config.recoveryMaintenance
    ? async (): Promise<void> => {}
    : startLeaseReaper(
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
