import { mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { buildInvestigationApp } from "./app.js";
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
            resolveSubject: async (id, repositoryId, workItemId) =>
              resolveInvestigationSubject(store, repositoryId, workItemId, id) ?? null,
          }));
    app = buildInvestigationApp({
      store,
      authenticateOperator: auth.authenticateOperator,
      authenticateWorker: auth.authenticateWorker,
      prepareTaskInput: sourceImporter.prepareTaskInput,
      resolveTaskSource: sourceImporter.resolveTaskSource,
      resolvePlanPrerequisites: sourceImporter.resolvePlanPrerequisites,
      enableExternalWrites: config.enableExternalWrites,
      evidencePolicy: config.evidencePolicy,
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
    });
    const runtimeAuth = auth;
    const runtimeApp = app;
    app.addHook("onClose", async () => {
      if (reaper !== undefined) clearInterval(reaper);
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
