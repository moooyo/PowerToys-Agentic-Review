import { mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import fastifyStatic from "@fastify/static";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { buildInvestigationApp } from "./app.js";
import { InvestigationAutomaticReplies } from "./auto-reply.js";
import {
  type AutomaticReplySettingsUpdate,
  InvestigationAutomaticReplySettings,
} from "./auto-reply-settings.js";
import { requireCondition } from "./errors.js";
import { InvestigationGitHubTransport } from "./github-transport.js";
import { InvestigationRuntimeAuth } from "./runtime-auth.js";
import {
  type InvestigationRuntimeConfig,
  loadInvestigationRuntimeConfig,
} from "./runtime-config.js";
import { resolveInvestigationSubject } from "./service.js";
import {
  InvestigationSourceImporter,
  loadInvestigationExecutionBindings,
} from "./source-import.js";
import { InvestigationStore } from "./store.js";
import type { InvestigationActionTransport } from "./types.js";
import { registerInvestigationWebhookRoute } from "./webhook-http.js";
import { InvestigationWebhookIntake } from "./webhook-intake.js";
import { InvestigationWebhookSettings } from "./webhook-settings.js";

export interface InvestigationRuntimeDependencies {
  readonly actionTransport?: InvestigationActionTransport;
  readonly logger?: false;
  readonly sourceImportFetch?: typeof globalThis.fetch;
}

export async function createInvestigationRuntime(
  config: InvestigationRuntimeConfig,
  dependencies: InvestigationRuntimeDependencies = {},
): Promise<FastifyInstance> {
  for (const databasePath of [config.databasePath, config.authDatabasePath]) {
    if (databasePath === ":memory:") continue;
    const pathFromDashboard = relative(config.dashboardDirectory, databasePath);
    if (
      pathFromDashboard === "" ||
      (!isAbsolute(pathFromDashboard) &&
        pathFromDashboard !== ".." &&
        !pathFromDashboard.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
    ) {
      throw new Error("Private database files must be outside the dashboard static directory.");
    }
  }
  const indexPath = join(config.dashboardDirectory, "index.html");
  if (!statSync(indexPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      "The dashboard bundle is missing. Build the dashboard and configure INVESTIGATION_DASHBOARD_DIRECTORY.",
    );
  }
  if (config.databasePath !== ":memory:")
    mkdirSync(dirname(config.databasePath), { recursive: true });
  const store = new InvestigationStore(config.databasePath);
  let auth: InvestigationRuntimeAuth | undefined;
  let app: FastifyInstance | undefined;
  let reaper: NodeJS.Timeout | undefined;
  let webhook: InvestigationWebhookIntake | undefined;
  let automaticReplies: InvestigationAutomaticReplies | undefined;
  const webhookShutdown = new AbortController();
  const actionShutdown = new AbortController();
  try {
    auth = new InvestigationRuntimeAuth(config);
    await auth.initialize();
    const sourceImporter = new InvestigationSourceImporter({
      store,
      ...(config.github === undefined ? {} : { github: config.github }),
      ...(dependencies.sourceImportFetch === undefined
        ? {}
        : { fetch: dependencies.sourceImportFetch }),
      maximumBytes: config.sourceImportMaximumBytes,
      maximumPages: config.sourceImportMaximumPages,
      executionBindings: loadInvestigationExecutionBindings(config.executionBindingsPath),
    });
    const actionTransport =
      dependencies.actionTransport ??
      (config.github === undefined
        ? undefined
        : new InvestigationGitHubTransport({
            ...config.github,
            fetch: (input, init) =>
              globalThis.fetch(input, {
                ...init,
                signal: AbortSignal.any([
                  actionShutdown.signal,
                  ...(init?.signal == null ? [] : [init.signal]),
                ]),
              }),
            resolveSubject: async (id, repositoryId, workItemId) =>
              resolveInvestigationSubject(store, repositoryId, workItemId, id) ?? null,
          }));
    const webhookConfig = config.webhook;
    const runtimeAuth = auth;
    const automaticReplySettings = new InvestigationAutomaticReplySettings(
      store,
      config.enableExternalWrites &&
        actionTransport?.supportedActions.includes("comment") === true &&
        actionTransport.readPublisherIdentity !== undefined,
    );
    const webhookSettings = new InvestigationWebhookSettings(
      store,
      webhookConfig?.bindings ?? [],
      webhookConfig !== undefined,
    );
    app = buildInvestigationApp({
      store,
      authenticateOperator: auth.authenticateOperator,
      authenticateWorker: auth.authenticateWorker,
      prepareTaskInput: sourceImporter.prepareTaskInput,
      resolveTaskSource: sourceImporter.resolveTaskSource,
      resolvePlanPrerequisites: sourceImporter.resolvePlanPrerequisites,
      enableExternalWrites: config.enableExternalWrites,
      evidencePolicy: config.evidencePolicy,
      onReportSealed: (report, task) => automaticReplies?.enqueue(report, task),
      onRepositoryChanged: (previous, next) =>
        automaticReplySettings.invalidateRepository(previous, next),
      ...(config.https === undefined ? {} : { https: config.https }),
      logger: dependencies.logger ?? {
        level: "info",
        redact: [
          "req.headers.authorization",
          "req.headers.cookie",
          "res.headers['set-cookie']",
          "req.body.password",
          "req.body.currentPassword",
          "req.body.newPassword",
        ],
      },
      ...(actionTransport === undefined ? {} : { actionTransport }),
      registerIngressRoutes: (ingressApp, service) => {
        const params = Type.Object(
          { id: Type.String({ minLength: 1, maxLength: 256 }) },
          { additionalProperties: false },
        );
        const publisher = new InvestigationAutomaticReplies({
          store,
          settings: automaticReplySettings,
          actions: service.actions,
          resolveOperator: runtimeAuth.resolveOperator,
          ...(actionTransport?.readPublisherIdentity === undefined
            ? {}
            : { resolvePublisherIdentity: () => actionTransport.readPublisherIdentity!() }),
          enableExternalWrites: config.enableExternalWrites,
          onError: (code) =>
            ingressApp.log.error({ code }, "Automatic investigation reply needs attention."),
        });
        automaticReplies = publisher;
        ingressApp.get<{ Params: { id: string } }>(
          "/api/repositories/:id/auto-reply-settings",
          { schema: { params } },
          async (request, reply) => {
            const actor = runtimeAuth.authenticateOperator(request);
            requireCondition(
              actor !== null,
              401,
              "operator_authentication_required",
              "Operator authentication is required.",
            );
            reply.header("cache-control", "no-store");
            return automaticReplySettings.read(actor, request.params.id);
          },
        );
        ingressApp.put<{ Params: { id: string }; Body: AutomaticReplySettingsUpdate }>(
          "/api/repositories/:id/auto-reply-settings",
          {
            schema: {
              params,
              body: Type.Object(
                {
                  version: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
                  enabled: Type.Boolean(),
                  pullRequestTemplate: Type.String({ minLength: 1, maxLength: 12_000 }),
                  issueTemplate: Type.String({ minLength: 1, maxLength: 12_000 }),
                },
                { additionalProperties: false },
              ),
            },
          },
          async (request, reply) => {
            const actor = runtimeAuth.authenticateOperator(request);
            requireCondition(
              actor !== null,
              401,
              "operator_authentication_required",
              "Operator authentication is required.",
            );
            reply.header("cache-control", "no-store");
            return automaticReplySettings.update(actor, request.params.id, request.body);
          },
        );
        ingressApp.get<{ Params: { id: string } }>(
          "/api/repositories/:id/auto-replies",
          { schema: { params } },
          async (request, reply) => {
            const actor = runtimeAuth.authenticateOperator(request);
            requireCondition(
              actor !== null,
              401,
              "operator_authentication_required",
              "Operator authentication is required.",
            );
            reply.header("cache-control", "no-store");
            return publisher.list(actor, request.params.id);
          },
        );
        ingressApp.get<{ Params: { id: string } }>(
          "/api/repositories/:id/webhook-settings",
          { schema: { params } },
          async (request, reply) => {
            const actor = await runtimeAuth.authenticateOperator(request);
            requireCondition(
              actor !== null,
              401,
              "operator_authentication_required",
              "Operator authentication is required.",
            );
            reply.header("cache-control", "no-store");
            return webhookSettings.read(actor, request.params.id);
          },
        );
        ingressApp.put<{
          Params: { id: string };
          Body: Parameters<InvestigationWebhookSettings["update"]>[2];
        }>(
          "/api/repositories/:id/webhook-settings",
          {
            schema: {
              params,
              body: Type.Object(
                {
                  version: Type.Integer({ minimum: 0 }),
                  enabled: Type.Boolean(),
                  reviewerUserId: Type.Union([
                    Type.Null(),
                    Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
                  ]),
                  allowedActorUserIds: Type.Array(
                    Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
                    { maxItems: 1024, uniqueItems: true },
                  ),
                },
                { additionalProperties: false },
              ),
            },
          },
          async (request, reply) => {
            const actor = await runtimeAuth.authenticateOperator(request);
            requireCondition(
              actor !== null,
              401,
              "operator_authentication_required",
              "Operator authentication is required.",
            );
            reply.header("cache-control", "no-store");
            return webhookSettings.update(actor, request.params.id, request.body);
          },
        );
        if (webhookConfig === undefined) return;
        const webhookImporter = new InvestigationSourceImporter({
          store,
          ...(config.github === undefined ? {} : { github: config.github }),
          maximumBytes: config.sourceImportMaximumBytes,
          maximumPages: config.sourceImportMaximumPages,
          fetch: (input, init) =>
            (dependencies.sourceImportFetch ?? globalThis.fetch)(input, {
              ...init,
              signal: AbortSignal.any([
                webhookShutdown.signal,
                ...(init?.signal == null ? [] : [init.signal]),
              ]),
            }),
        });
        const intake = new InvestigationWebhookIntake({
          store,
          config: webhookConfig,
          service,
          importer: webhookImporter,
          settings: webhookSettings,
          onError: (code) => ingressApp.log.error({ code }, "Webhook task intake needs attention."),
        });
        webhook = intake;
        registerInvestigationWebhookRoute(ingressApp, {
          secret: webhookConfig.secret,
          maximumPayloadBytes: webhookConfig.maximumPayloadBytes,
          accept: (input) => intake.accept(input),
        });
        ingressApp.get<{ Params: { deliveryId: string } }>(
          "/api/github/webhook-deliveries/:deliveryId",
          {
            schema: {
              params: Type.Object(
                { deliveryId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }) },
                { additionalProperties: false },
              ),
            },
          },
          async (request, reply) => {
            const actor = await runtimeAuth.authenticateOperator(request);
            requireCondition(
              actor !== null,
              401,
              "operator_authentication_required",
              "Operator authentication is required.",
            );
            reply.header("cache-control", "no-store");
            return intake.readReceipt(actor, request.params.deliveryId);
          },
        );
      },
    });
    const runtimeApp = app;
    app.addHook("onClose", async () => {
      if (reaper !== undefined) clearInterval(reaper);
      webhookShutdown.abort();
      await webhook?.stop();
      await automaticReplies?.stop();
      actionShutdown.abort();
      try {
        runtimeAuth.close();
      } finally {
        store.close();
      }
    });
    auth.registerRoutes(app);
    sourceImporter.registerRoutes(app, auth.authenticateOperator);
    app.register(fastifyStatic, {
      root: config.dashboardDirectory,
      prefix: "/",
      dotfiles: "deny",
      index: "index.html",
      setHeaders(response, filePath) {
        response.header("x-content-type-options", "nosniff");
        response.header("referrer-policy", "same-origin");
        if (filePath.endsWith(".html")) response.header("cache-control", "no-store");
      },
    });
    app.setNotFoundHandler(async (request, reply) => {
      const pathname = request.url.split("?", 1)[0] ?? request.url;
      if (
        request.method === "GET" &&
        request.headers.accept?.includes("text/html") === true &&
        pathname !== "/api" &&
        !pathname.startsWith("/api/")
      ) {
        return reply.header("cache-control", "no-store").sendFile("index.html");
      }
      return reply
        .code(404)
        .send({ code: "not_found", message: "The requested resource does not exist." });
    });
    await app.ready();
    webhook?.start();
    automaticReplies?.start();
    reaper = setInterval(() => {
      try {
        runtimeAuth.reapExpired();
      } catch {
        runtimeApp.log.error("Expired authentication record cleanup failed.");
      }
    }, 60_000);
    reaper.unref();
    return app;
  } catch (error) {
    if (reaper !== undefined) clearInterval(reaper);
    if (app !== undefined) await app.close().catch(() => undefined);
    auth?.close();
    store.close();
    throw error;
  }
}

export async function runInvestigationServer(): Promise<void> {
  let app: FastifyInstance | undefined;
  let stopRequested = false;
  let finish: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    stopRequested = true;
    if (app === undefined) return Promise.resolve();
    if (closing !== undefined) return closing;
    const runningApp = app;
    closing = (async () => {
      const deadline = setTimeout(() => {
        runningApp.log.error(
          "Server shutdown exceeded the grace period; closing remaining HTTP connections.",
        );
        process.exitCode = 1;
        runningApp.server.closeAllConnections();
      }, 30_000);
      deadline.unref();
      try {
        await runningApp.close();
      } finally {
        clearTimeout(deadline);
        finish?.();
      }
    })();
    return closing;
  };
  const onSignal = (): void => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const config = loadInvestigationRuntimeConfig();
    app = await createInvestigationRuntime(config);
    if (stopRequested) {
      await close();
      return;
    }
    await app.listen({ host: config.host, port: config.port });
    if (stopRequested) {
      await close();
      return;
    }
    app.log.info(
      {
        host: config.host,
        port: config.port,
        authMode: config.auth.mode,
        externalWrites: config.enableExternalWrites,
      },
      "Investigation Task/Report server is ready.",
    );
    await stopped;
  } catch (error) {
    process.exitCode = 1;
    console.error(
      JSON.stringify({
        level: "fatal",
        message: "Investigation server failed.",
        error: error instanceof Error ? error.message : "Unknown startup failure.",
      }),
    );
    await close();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
