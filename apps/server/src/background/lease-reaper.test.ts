import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startLeaseReaper } from "../../dist/background/lease-reaper.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("startLeaseReaper", () => {
  it("stops interval admission on abort and drains the active database request", async () => {
    vi.useFakeTimers();
    const shutdownController = new AbortController();
    const requestResult = Promise.withResolvers<{ expiredCount: number }>();
    const request = vi.fn(() => requestResult.promise);
    const logger = { warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
    const stop = startLeaseReaper(
      { request } as never,
      {
        leaseReaperIntervalSeconds: 1,
        retryDelaySeconds: 30,
        workerOfflineAfterSeconds: 60,
      } as never,
      logger,
      shutdownController.signal,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(1);

    shutdownController.abort(new Error("Server shutdown started."));
    let firstStopCompleted = false;
    const firstStopping = stop().then(() => {
      firstStopCompleted = true;
    });
    const secondStopping = stop();
    await Promise.resolve();
    expect(firstStopCompleted).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(1);

    requestResult.resolve({ expiredCount: 1 });
    await Promise.all([firstStopping, secondStopping]);
    expect(firstStopCompleted).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      { expiredCount: 1 },
      "Expired worker leases were recovered.",
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
