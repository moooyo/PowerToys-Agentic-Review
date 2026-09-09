import type { FastifyBaseLogger } from "fastify";
import type { ServerConfig } from "../config.js";
import type { DatabaseClient } from "../database/database-client.js";

export const startLeaseReaper = (
  database: DatabaseClient,
  config: ServerConfig,
  logger: FastifyBaseLogger,
  shutdownSignal: AbortSignal,
  wakeScheduling: () => void = () => {},
): (() => Promise<void>) => {
  let stopped = false;
  let activeRun: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const reaperIntervalMilliseconds = config.leaseReaperIntervalSeconds * 1_000;
  let nextReapAt = performance.now() + reaperIntervalMilliseconds;
  let nextSchedulingWakeAt = performance.now() + 5_000;

  const stopAdmission = (): void => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
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
      }
      try {
        if (config.evidenceStorage !== undefined && !stopped) {
          try {
            await database.request("cleanupEvidenceAssets", { limit: 32 });
          } catch (error) {
            logger.error({ error }, "Evidence retention cleanup failed.");
          }
        }
      } finally {
        activeRun = undefined;
      }
    })();
  };

  const tick = (): void => {
    timer = undefined;
    if (stopped) return;
    const now = performance.now();
    try {
      wakeScheduling();
    } catch (error) {
      logger.error({ error }, "Scheduling wake failed.");
    }
    if (now >= nextSchedulingWakeAt) nextSchedulingWakeAt = now + 5_000;
    if (now >= nextReapAt) {
      nextReapAt = now + reaperIntervalMilliseconds;
      reap();
    }
    scheduleTick();
  };

  const scheduleTick = (): void => {
    if (stopped) return;
    timer = setTimeout(
      tick,
      Math.max(0, Math.min(nextReapAt, nextSchedulingWakeAt) - performance.now()),
    );
    timer.unref();
  };

  shutdownSignal.addEventListener("abort", stopAdmission, { once: true });
  if (shutdownSignal.aborted) {
    stopAdmission();
  } else {
    scheduleTick();
  }

  return async () => {
    stopAdmission();
    await activeRun;
  };
};
