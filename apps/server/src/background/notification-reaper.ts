import type { FastifyBaseLogger } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";

export const notificationReaperPolicy = Object.freeze({
  intervalMs: 60_000,
  continuationMs: 100,
  maximumBatches: 8,
  batchSize: 128,
});

/** Logical expiry is separate from bounded physical reclamation; neither sends notifications. */
export function startNotificationReaper(
  database: Pick<DatabaseClient, "request">,
  logger: Pick<FastifyBaseLogger, "error">,
  shutdown: AbortSignal,
): () => Promise<void> {
  let stopped = shutdown.aborted;
  let active: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let remaining = 0;

  const stopAdmission = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    shutdown.removeEventListener("abort", stopAdmission);
  };
  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (remaining === 0) remaining = notificationReaperPolicy.maximumBatches;
      run();
    }, delay);
    timer.unref();
  };
  const run = () => {
    if (stopped || active !== undefined || remaining === 0) return;
    remaining -= 1;
    let more = false;
    active = database
      .request("maintainNotifications", { limit: notificationReaperPolicy.batchSize })
      .then((result) => {
        more = result.hasMore === true;
      })
      .catch((error: unknown) => {
        logger.error({ error }, "Notification retention maintenance failed.");
      })
      .finally(() => {
        active = undefined;
        if (!more) remaining = 0;
        schedule(
          more && remaining > 0
            ? notificationReaperPolicy.continuationMs
            : notificationReaperPolicy.intervalMs,
        );
      });
  };

  if (!stopped) {
    shutdown.addEventListener("abort", stopAdmission, { once: true });
    remaining = notificationReaperPolicy.maximumBatches;
    run();
  }
  return async () => {
    stopAdmission();
    await active;
  };
}
