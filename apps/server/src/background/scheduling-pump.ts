import type { FastifyBaseLogger } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";

export interface SchedulingPump {
  wake(): void;
  stop(): Promise<void>;
}

/** One owner coalesces wake hints; database results never recursively refill this queue. */
export const startSchedulingPump = (
  database: Pick<DatabaseClient, "request" | "subscribeSchedulingChanges">,
  logger: FastifyBaseLogger,
  shutdownSignal: AbortSignal,
): SchedulingPump => {
  let stopped = false;
  let pending = false;
  let queued: NodeJS.Immediate | undefined;
  let active: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;

  const run = async (): Promise<void> => {
    try {
      await database.request("dispatchPendingReviewRuns", { limit: 32 });
    } catch (error) {
      logger.error({ error }, "Pending validation dispatch failed.");
    }
    if (stopped) return;
    try {
      await database.request("admitPendingJobs", { limit: 32 });
    } catch (error) {
      logger.error({ error }, "Pending job admission failed.");
    }
  };

  const queue = (): void => {
    if (stopped || queued !== undefined || active !== undefined || !pending) return;
    queued = setImmediate(() => {
      queued = undefined;
      if (stopped || !pending) return;
      pending = false;
      active = run().finally(() => {
        active = undefined;
        queue();
      });
    });
    queued.unref();
  };

  const wake = (): void => {
    if (stopped) return;
    pending = true;
    queue();
  };

  const stopAdmission = (): void => {
    stopped = true;
    pending = false;
    if (queued !== undefined) {
      clearImmediate(queued);
      queued = undefined;
    }
    unsubscribe?.();
    unsubscribe = undefined;
    shutdownSignal.removeEventListener("abort", stopAdmission);
  };

  shutdownSignal.addEventListener("abort", stopAdmission, { once: true });
  if (shutdownSignal.aborted) stopAdmission();
  else {
    unsubscribe = database.subscribeSchedulingChanges(wake);
    wake();
  }

  return {
    wake,
    async stop() {
      stopAdmission();
      await active;
    },
  };
};
