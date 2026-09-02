import type { FastifyBaseLogger } from "fastify";
import type { ServerConfig } from "../config.js";
import type { DatabaseClient } from "../database/database-client.js";

export const startLeaseReaper = (
  database: DatabaseClient,
  config: ServerConfig,
  logger: FastifyBaseLogger,
  shutdownSignal: AbortSignal,
): (() => Promise<void>) => {
  let stopped = false;
  let activeRun: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;

  const stopAdmission = (): void => {
    stopped = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    shutdownSignal.removeEventListener("abort", stopAdmission);
  };

  const reap = (): void => {
    if (stopped || activeRun !== undefined) {
      return;
    }

    activeRun = (async () => {
      try {
        const result = await database.request("reapExpiredLeases", {
          retryDelaySeconds: config.retryDelaySeconds,
          workerOfflineAfterSeconds: config.workerOfflineAfterSeconds,
        });
        if (result.expiredCount > 0) {
          logger.warn(
            { expiredCount: result.expiredCount },
            "Expired worker leases were recovered.",
          );
        }
      } catch (error) {
        logger.error({ error }, "Lease reaper failed.");
      } finally {
        activeRun = undefined;
      }
    })();
  };

  shutdownSignal.addEventListener("abort", stopAdmission, { once: true });
  if (shutdownSignal.aborted) {
    stopAdmission();
  } else {
    timer = setInterval(reap, config.leaseReaperIntervalSeconds * 1_000);
    timer.unref();
  }

  return async () => {
    stopAdmission();
    await activeRun;
  };
};
