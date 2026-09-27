import { mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  InvestigationMediaPublicationSchema,
  type InvestigationResultV1,
  type InvestigationTaskV1,
} from "@agentic-review/contracts";
import fastifyStatic from "@fastify/static";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { buildInvestigationApp } from "./app.js";
import { InvestigationAutomaticReplies } from "./auto-reply.js";
import {
  type AutomaticReplySettingsUpdate,
  InvestigationAutomaticReplySettings,
} from "./auto-reply-settings.js";
import { InvestigationCommentDeliveries } from "./comment-deliveries.js";
import { registerInvestigationCommentRoutes } from "./comment-http.js";
import { InvestigationE2eIntake } from "./e2e-intake.js";
import { createInvestigationE2eMediaPublications } from "./e2e-media-runtime.js";
import { requireCondition } from "./errors.js";
import { InvestigationGitHubTransport } from "./github-transport.js";
import { InvestigationOperations, registerInvestigationOperationsRoute } from "./operations.js";
import { InvestigationProgressReplies } from "./progress-reply.js";
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
import { InvestigationWebhookDeliveryControls } from "./webhook-delivery-controls.js";
import { registerInvestigationWebhookDeliveryRoutes } from "./webhook-delivery-http.js";
import { registerInvestigationWebhookRoute } from "./webhook-http.js";
import { InvestigationWebhookIntake } from "./webhook-intake.js";
import { InvestigationWebhookSettings } from "./webhook-settings.js";
import { InvestigationWorkerControls } from "./worker-controls.js";

export interface InvestigationRuntimeDependencies {
  readonly actionTransport?: InvestigationActionTransport;
  readonly logger?: false;
  readonly sourceImportFetch?: typeof globalThis.fetch;
  readonly mediaUploadFetch?: typeof globalThis.fetch;
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
  const workerControls = new InvestigationWorkerControls(store);
  let auth: InvestigationRuntimeAuth | undefined;
  let app: FastifyInstance | undefined;
  let reaper: NodeJS.Timeout | undefined;
  let taskReaper: NodeJS.Timeout | undefined;
  let reapTaskLeases: (() => void) | undefined;
  let webhook: InvestigationWebhookIntake | undefined;
  let e2eWebhook: InvestigationE2eIntake | undefined;
  let automaticReplies: InvestigationAutomaticReplies | undefined;
  let progressReplies: InvestigationProgressReplies | undefined;
  const webhookShutdown = new AbortController();
  const actionShutdown = new AbortController();
  const mediaShutdown = new AbortController();
  try {
    auth = new InvestigationRuntimeAuth(config);
    await auth.initialize();
    workerControls.initialize(config.workers);
    const sourceImporter = new InvestigationSourceImporter({
      store,
      ...(config.github === undefined ? {} : { github: config.github }),
      ...(dependencies.sourceImportFetch === undefined
        ? {}
        : { fetch: dependencies.sourceImportFetch }),
      maximumBytes: config.sourceImportMaximumBytes,
      maximumPages: config.sourceImportMaximumPages,
      executionBindings: loadInvestigationExecutionBindings(config.executionBindingsPath),
      classifyProgressComment: (repository, target, comment) =>
        progressReplies?.classifyProgressComment(repository, target, comment),
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
      workerControls,
      authenticateOperator: auth.authenticateOperator,
      authenticateWorker: auth.authenticateWorker,
      prepareTaskInput: sourceImporter.prepareTaskInput,
      resolveTaskSource: sourceImporter.resolveTaskSource,
      resolvePlanPrerequisites: sourceImporter.resolvePlanPrerequisites,
      enableExternalWrites: config.enableExternalWrites,
      evidencePolicy: config.evidencePolicy,
      ...(config.staticConcurrency === undefined
        ? {}
        : { staticConcurrency: config.staticConcurrency }),
      ...(config.defaultTaskBudget === undefined
        ? {}
        : { defaultTaskBudget: config.defaultTaskBudget }),
      onReportSealed: (report, task) => {
        progressReplies?.enqueueResult(report, task);
      },
      onTaskStateChanged: (task, report) => progressReplies?.update(task, report),
      onTaskUsageChanged: (task) => progressReplies?.updateUsage(task),
      onTaskProgress: (task, checkpoint, attempt) =>
        progressReplies?.updateProgress(task, checkpoint, attempt),
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
        reapTaskLeases = () => service.reapExpiredLeases();
        registerInvestigationOperationsRoute(ingressApp, {
          authenticateOperator: runtimeAuth.authenticateOperator,
          operations: new InvestigationOperations({
            store,
            databasePath: config.databasePath,
            authDatabasePath: config.authDatabasePath,
            evidencePolicy: service.evidence.policy,
          }),
        });
        const params = Type.Object(
          { id: Type.String({ minLength: 1, maxLength: 256 }) },
          { additionalProperties: false },
        );
        const deliveries = new InvestigationCommentDeliveries({ store });
        const media = createInvestigationE2eMediaPublications({
          store,
          evidence: service.evidence,
          enableExternalWrites: config.enableExternalWrites,
          ...(config.github === undefined ? {} : { github: config.github }),
          ...(config.media === undefined ? {} : { configuration: config.media }),
          fetch: (input, init) =>
            (dependencies.mediaUploadFetch ?? globalThis.fetch)(input, {
              ...init,
              signal: AbortSignal.any([
                actionShutdown.signal,
                mediaShutdown.signal,
                ...(init?.signal == null ? [] : [init.signal]),
              ]),
            }),
        });
        const prepareReportMedia = async (
          report: InvestigationResultV1,
          task: InvestigationTaskV1,
        ): Promise<string> => {
          const grant = automaticReplySettings.policy(task.repository.id);
          const assertMediaAuthorization = () => {
            const policy = automaticReplySettings.policy(task.repository.id);
            const authorizer =
              policy === null ? null : runtimeAuth.resolveOperator(policy.authorizedById);
            requireCondition(
              grant !== null &&
                policy !== null &&
                authorizer !== null &&
                policy.authorizedById === grant.authorizedById &&
                policy.authorizationEpoch === grant.authorizationEpoch &&
                policy.repository.fullName === task.repository.fullName &&
                policy.repository.githubRepositoryId === task.repository.githubRepositoryId &&
                authorizer.repositoryIds.includes(task.repository.id) &&
                authorizer.permissions.includes("action:prepare") &&
                authorizer.permissions.includes("action:execute") &&
                authorizer.actionCapabilities.includes("comment"),
              403,
              "e2e_media_authorization_changed",
              "The E2E media publication authorization is no longer current.",
            );
          };
          assertMediaAuthorization();
          media.prepare(report, task);
          await media.publish(report.report.id, mediaShutdown.signal, assertMediaAuthorization);
          return media.render(report.report.id);
        };
        const publisher = new InvestigationAutomaticReplies({
          recoveryOnly: true,
          usageSummary: (taskId) => service.usageSummary(taskId),
          prepareReportMedia,
          store,
          deliveries,
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
        const progress = new InvestigationProgressReplies({
          usageSummary: (taskId) => service.usageSummary(taskId),
          prepareReportMedia,
          store,
          deliveries,
          settings: automaticReplySettings,
          transport: actionTransport,
          resolveOperator: runtimeAuth.resolveOperator,
          enableExternalWrites: config.enableExternalWrites,
          isAssignmentAuthorized: (admission) =>
            webhookSettings
              .bindings()
              .some(
                (binding) =>
                  binding.repositoryId === admission.repository.id &&
                  binding.reviewerUserId === admission.expectedAssigneeUserId &&
                  (admission.mode === "e2e"
                    ? binding.e2eEnabled === true
                    : binding.assignmentsEnabled !== false) &&
                  binding.allowedActorUserIds.includes(admission.trigger.actorUserId),
              ),
          onError: (code) =>
            ingressApp.log.error({ code }, "Investigation progress comment needs attention."),
        });
        progressReplies = progress;
        registerInvestigationCommentRoutes(ingressApp, {
          authenticateOperator: runtimeAuth.authenticateOperator,
          deliveries,
          progress,
          automaticReplies: publisher,
          workspace: service.workspace,
        });
        ingressApp.get<{ Params: { id: string } }>(
          "/api/reports/:id/media-publication",
          { schema: { params, response: { 200: InvestigationMediaPublicationSchema } } },
          async (request, reply) => {
            const actor = runtimeAuth.authenticateOperator(request);
            requireCondition(
              actor !== null,
              401,
              "operator_authentication_required",
              "Operator authentication is required.",
            );
            const report = service.reportExport(actor, request.params.id);
            requireCondition(
              report.context.task.kind === "pr-e2e",
              400,
              "e2e_media_report_required",
              "Media publication status belongs to an E2E report.",
            );
            reply.header("cache-control", "no-store");
            return {
              reportId: report.report.id,
              ...media.status(report.report.id),
              uploads: media.uploads(report.report.id).map((upload) => ({
                artifactId: upload.artifact.id,
                name: upload.artifact.name,
                mediaType: upload.artifact.mediaType,
                digest: upload.artifact.digest,
                state: upload.state,
                url: upload.url,
                reason: upload.code,
                featureIds: upload.bindings.map((binding) => binding.featureId),
              })),
            };
          },
        );
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
                  progressEnabled: Type.Optional(Type.Boolean()),
                  reauthorize: Type.Optional(Type.Boolean()),
                  progressTemplates: Type.Optional(
                    Type.Object(
                      {
                        received: Type.String({ minLength: 1, maxLength: 12_000 }),
                        started: Type.String({ minLength: 1, maxLength: 12_000 }),
                        failed: Type.String({ minLength: 1, maxLength: 12_000 }),
                        completed: Type.String({ minLength: 1, maxLength: 12_000 }),
                      },
                      { additionalProperties: false },
                    ),
                  ),
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
          "/api/repositories/:id/progress-replies",
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
            return progress.list(actor, request.params.id);
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
                  e2eEnabled: Type.Optional(Type.Boolean()),
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
        if (webhookConfig === undefined) {
          registerInvestigationWebhookDeliveryRoutes(ingressApp, {
            controls: new InvestigationWebhookDeliveryControls({ store }),
            authenticateOperator: runtimeAuth.authenticateOperator,
          });
          return;
        }
        const webhookImporter = new InvestigationSourceImporter({
          store,
          classifyProgressComment: (repository, target, comment) =>
            progress.classifyProgressComment(repository, target, comment),
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
          onAssignmentAccepted: (admission) => progress.enqueueAssignment(admission),
          onAssignmentChanged: (admission, state, reasonCode) =>
            progress.updateAssignment(admission.id, state, reasonCode),
          onTaskCreated: (task, _trigger, _created, admission) => {
            if (admission !== undefined) progress.attachTask(admission.id, task);
          },
          onError: (code) => ingressApp.log.error({ code }, "Webhook task intake needs attention."),
        });
        webhook = intake;
        const e2eIntake = new InvestigationE2eIntake({
          store,
          service,
          importer: webhookImporter,
          settings: webhookSettings,
          onAdmission: (admission) => progress.enqueueAssignment(admission),
          onAdmissionChanged: (admission, state, reason) =>
            progress.updateAssignment(admission.id, state, reason),
          onTaskCreated: (admission, task) => progress.attachTask(admission.id, task),
          isOwnComment: (repositoryId, commentId) => progress.isOwnComment(repositoryId, commentId),
          onError: (code) => ingressApp.log.error({ code }, "E2E webhook intake needs attention."),
        });
        e2eWebhook = e2eIntake;
        registerInvestigationWebhookRoute(ingressApp, {
          secret: webhookConfig.secret,
          maximumPayloadBytes: webhookConfig.maximumPayloadBytes,
          accept: (input) => {
            if (
              input.eventName === "issue_comment" ||
              (input.eventName === "pull_request" &&
                typeof input.payload === "object" &&
                input.payload !== null &&
                "action" in input.payload &&
                input.payload.action === "synchronize")
            )
              return e2eIntake.accept(input);
            return intake.accept(input);
          },
        });
        registerInvestigationWebhookDeliveryRoutes(ingressApp, {
          controls: new InvestigationWebhookDeliveryControls({ store, intake, e2eIntake }),
          authenticateOperator: runtimeAuth.authenticateOperator,
        });
      },
    });
    const runtimeApp = app;
    app.addHook("onClose", async () => {
      if (reaper !== undefined) clearInterval(reaper);
      if (taskReaper !== undefined) clearInterval(taskReaper);
      webhookShutdown.abort();
      await webhook?.stop();
      await e2eWebhook?.stop();
      mediaShutdown.abort();
      await automaticReplies?.stop();
      await progressReplies?.stop();
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
    reapTaskLeases?.();
    webhook?.start();
    e2eWebhook?.start();
    automaticReplies?.start();
    progressReplies?.start();
    reaper = setInterval(() => {
      try {
        runtimeAuth.reapExpired();
      } catch {
        runtimeApp.log.error("Expired authentication record cleanup failed.");
      }
    }, 60_000);
    reaper.unref();
    taskReaper = setInterval(() => {
      try {
        reapTaskLeases?.();
      } catch {
        runtimeApp.log.error("Expired investigation Worker lease cleanup failed.");
      }
    }, 30_000);
    taskReaper.unref();
    return app;
  } catch (error) {
    if (reaper !== undefined) clearInterval(reaper);
    if (taskReaper !== undefined) clearInterval(taskReaper);
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
