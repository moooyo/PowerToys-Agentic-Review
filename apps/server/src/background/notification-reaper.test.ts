import { afterEach, describe, expect, it, vi } from "vitest";
import {
  notificationReaperPolicy as policy,
  startNotificationReaper,
} from "./notification-reaper.js";

afterEach(() => vi.useRealTimers());
const empty = {
  retainedAfter: "2026-09-07T00:00:00.000Z",
  deletedStates: 0,
  deletedReceipts: 0,
  deletedEvents: 0,
  deletedCounters: 0,
  hasMore: false,
};

describe("notification retention lifecycle", () => {
  it("performs bounded sweeps with a delay after the batch budget", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({
      ...empty,
      deletedEvents: policy.batchSize,
      hasMore: true,
    }));
    const logger = { error: vi.fn() };
    const stop = startNotificationReaper(
      { request } as never,
      logger,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(policy.continuationMs * policy.maximumBatches);
    expect(request).toHaveBeenCalledTimes(policy.maximumBatches);
    expect(request).toHaveBeenCalledWith("maintainNotifications", { limit: 128 });
    await vi.advanceTimersByTimeAsync(policy.intervalMs - policy.continuationMs - 1);
    expect(request).toHaveBeenCalledTimes(policy.maximumBatches);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(policy.maximumBatches + 1);
    await stop();
    expect(logger.error).not.toHaveBeenCalled();
  });
  it("does not overlap slow maintenance and drains the admitted operation on stop", async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<typeof empty>();
    const request = vi.fn(() => pending.promise);
    const controller = new AbortController();
    const stop = startNotificationReaper(
      { request } as never,
      { error: vi.fn() },
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(policy.intervalMs * 3);
    expect(request).toHaveBeenCalledTimes(1);
    controller.abort();
    let drained = false;
    const stopping = stop().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    pending.resolve({ ...empty, hasMore: true });
    await stopping;
    await stop();
    await vi.advanceTimersByTimeAsync(policy.intervalMs * 3);
    expect(request).toHaveBeenCalledTimes(1);
    expect(drained).toBe(true);
  });
  it("backs off after a failed batch and remains available for a later sweep", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("Owner unavailable"))
      .mockResolvedValue(empty);
    const logger = { error: vi.fn() };
    const stop = startNotificationReaper(
      { request } as never,
      logger,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(policy.intervalMs - 1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    await stop();
  });
  it("does not admit work when shutdown was already requested", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn();
    const stop = startNotificationReaper(
      { request } as never,
      { error: vi.fn() },
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(policy.intervalMs * 2);
    await stop();
    expect(request).not.toHaveBeenCalled();
  });
});
