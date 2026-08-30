import type { FastifyBaseLogger } from "fastify";
import type { ServerConfig } from "../config.js";
import type { DatabaseClient } from "../database/database-client.js";

const maximumBatchesPerSweep = 8;

export const startOperatorAuthReaper = (
  database: Pick<DatabaseClient, "request">,
  config: Pick<ServerConfig, "operatorAuthCleanupBatchSize" | "operatorAuthCleanupIntervalSeconds">,
  logger: FastifyBaseLogger,
): (() => Promise<void>) => {
  let stopped = false;
  let activeRun: Promise<void> | undefined;
  let continuationTimer: NodeJS.Timeout | undefined;
  let remainingBatches = 0;

  const runBatch = (): void => {
    if (stopped || activeRun !== undefined || remainingBatches <= 0) {
      return;
    }
    remainingBatches -= 1;

    let hasMore = false;
    activeRun = database
      .request("cleanupExpiredOperatorAuth", {
        batchSize: config.operatorAuthCleanupBatchSize,
      })
      .then((result) => {
        hasMore = result.hasMore;
        const deletedCount =
          result.deletedBrowserFlows + result.deletedLoginTransactions + result.deletedSessions;
        if (deletedCount > 0) {
          logger.info(
            {
              deletedBrowserFlows: result.deletedBrowserFlows,
              deletedLoginTransactions: result.deletedLoginTransactions,
              deletedSessions: result.deletedSessions,
              hasMore: result.hasMore,
            },
            "Expired operator authentication records were removed.",
          );
        }
      })
      .catch((error: unknown) => {
        logger.error({ error }, "Operator authentication cleanup failed.");
      })
      .finally(() => {
        activeRun = undefined;
        if (hasMore && !stopped && remainingBatches > 0) {
          continuationTimer = setTimeout(() => {
            continuationTimer = undefined;
            runBatch();
          }, 0);
          continuationTimer.unref();
        }
      });
  };

  const startSweep = (): void => {
    if (stopped || activeRun !== undefined || continuationTimer !== undefined) {
      return;
    }
    remainingBatches = maximumBatchesPerSweep;
    runBatch();
  };

  startSweep();
  const intervalTimer = setInterval(startSweep, config.operatorAuthCleanupIntervalSeconds * 1_000);
  intervalTimer.unref();

  return async () => {
    stopped = true;
    clearInterval(intervalTimer);
    if (continuationTimer !== undefined) {
      clearTimeout(continuationTimer);
    }
    await activeRun;
  };
};
