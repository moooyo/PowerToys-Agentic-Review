import { mkdir } from "node:fs/promises";
import process from "node:process";
import { loadWorkerConfig } from "./config.js";
import { PlaceholderJobExecutor } from "./execution/job-executor.js";
import { UnavailableProcessHostClient } from "./execution/process-host-protocol.js";
import { ConsoleJsonLogger } from "./logging/logger.js";
import { WorkerApiError } from "./server-client/errors.js";
import { HttpWorkerApi } from "./server-client/http-worker-api.js";
import { WorkerService } from "./worker-service.js";

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Agentic Review Worker can run only on Windows.");
  }

  const config = loadWorkerConfig();
  if (config.executionEnabled) {
    throw new Error(
      "Worker execution remains disabled until the control/executor identity boundary and Windows runtime preflight are connected.",
    );
  }
  await mkdir(config.dataDirectory, { recursive: true });
  const logger = new ConsoleJsonLogger(config.logLevel, {
    component: "worker",
    workerNodeId: config.workerNodeId,
  });
  const api = new HttpWorkerApi(config, logger);
  const processHost = new UnavailableProcessHostClient();
  const executor = new PlaceholderJobExecutor();
  const service = new WorkerService(config, api, executor, processHost, logger);
  let shutdownRequested = false;

  const requestShutdown = (signal: string): void => {
    if (shutdownRequested) {
      return;
    }
    shutdownRequested = true;
    logger.info("Operating system requested worker shutdown.", { signal });
    void service.stop(`signal:${signal}`).catch((error: unknown) => {
      logger.error("Worker shutdown failed.", { error });
      process.exitCode = 1;
    });
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
    process.once(signal, () => requestShutdown(signal));
  }

  try {
    await service.run();
  } catch (error) {
    if (shutdownRequested) {
      await service.stop("operating_system_shutdown");
      return;
    }
    if (error instanceof WorkerApiError && error.isWorkerInstanceSuperseded) {
      logger.warn("Worker stopped because a newer process instance owns this node.");
      await service.stop("instance_superseded");
      return;
    }
    logger.error("Worker stopped because of an unrecoverable error.", { error });
    process.exitCode = 1;
    await service.stop("fatal_error").catch((shutdownError: unknown) => {
      logger.error("Cleanup after fatal error failed.", { error: shutdownError });
    });
  }
}

await main().catch((error: unknown) => {
  const fallback = new ConsoleJsonLogger("error", { component: "worker" });
  fallback.error("Worker failed during startup.", { error });
  process.exitCode = 1;
});
