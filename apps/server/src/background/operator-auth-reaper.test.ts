import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startOperatorAuthReaper } from "../../dist/background/operator-auth-reaper.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("startOperatorAuthReaper", () => {
  it("runs on startup and continues bounded cleanup while expired rows remain", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        deletedBrowserFlows: 0,
        deletedLoginTransactions: 2,
        deletedSessions: 2,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        deletedBrowserFlows: 1,
        deletedLoginTransactions: 1,
        deletedSessions: 0,
        hasMore: false,
      });
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    } as unknown as FastifyBaseLogger;

    const stop = startOperatorAuthReaper(
      { request } as never,
      {
        operatorAuthCleanupBatchSize: 2,
        operatorAuthCleanupIntervalSeconds: 86_400,
      },
      logger,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await stop();

    expect(request.mock.calls[0]?.[0]).toBe("cleanupExpiredOperatorAuth");
    expect(request.mock.calls[0]?.[1]).toMatchObject({ batchSize: 2 });
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("limits one cleanup sweep even when every batch reports more rows", async () => {
    const request = vi.fn(async () => ({
      deletedBrowserFlows: 1,
      deletedLoginTransactions: 1,
      deletedSessions: 1,
      hasMore: true,
    }));
    const logger = { info: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
    const stop = startOperatorAuthReaper(
      { request } as never,
      {
        operatorAuthCleanupBatchSize: 1,
        operatorAuthCleanupIntervalSeconds: 86_400,
      },
      logger,
      new AbortController().signal,
    );

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(8));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(request).toHaveBeenCalledTimes(8);
    await stop();
  });

  it("stops interval and continuation admission on abort while draining the active request", async () => {
    vi.useFakeTimers();
    const shutdownController = new AbortController();
    const requestResult = Promise.withResolvers<{
      deletedBrowserFlows: number;
      deletedLoginTransactions: number;
      deletedSessions: number;
      hasMore: boolean;
    }>();
    const request = vi.fn(() => requestResult.promise);
    const logger = { info: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
    const stop = startOperatorAuthReaper(
      { request } as never,
      {
        operatorAuthCleanupBatchSize: 1,
        operatorAuthCleanupIntervalSeconds: 1,
      },
      logger,
      shutdownController.signal,
    );
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

    requestResult.resolve({
      deletedBrowserFlows: 0,
      deletedLoginTransactions: 0,
      deletedSessions: 0,
      hasMore: true,
    });
    await Promise.all([firstStopping, secondStopping]);
    expect(firstStopCompleted).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
