import type { FastifyBaseLogger } from "fastify";
import type { ServerConfig } from "../config.js";
import type { DatabaseClient } from "../database/database-client.js";

export const startLeaseReaper = (
  database: DatabaseClient,
  config: ServerConfig,
  logger: FastifyBaseLogger,
): (() => void) => {
  let running = false;

  const reap = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      const result = await database.request("reapExpiredLeases", {
        retryDelaySeconds: config.retryDelaySeconds,
        workerOfflineAfterSeconds: config.workerOfflineAfterSeconds,
      });
      if (result.expiredCount > 0) {
        logger.warn({ expiredCount: result.expiredCount }, "Expired worker leases were recovered.");
      }
    } catch (error) {
      logger.error({ error }, "Lease reaper failed.");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void reap(), config.leaseReaperIntervalSeconds * 1_000);
  timer.unref();
  return () => clearInterval(timer);
};
