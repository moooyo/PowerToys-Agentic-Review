import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startLeaseReaper } from "./lease-reaper.js";

afterEach(() => vi.useRealTimers());
const configuration = (seconds = 1) => ({
  leaseReaperIntervalSeconds: seconds,
  retryDelaySeconds: 30,
  workerOfflineAfterSeconds: 60,
  evidenceStorage: {},
});
const logger = () => ({ warn: vi.fn(), error: vi.fn() }) as unknown as FastifyBaseLogger;

describe("startLeaseReaper", () => {
  it("wakes scheduling and continues evidence cleanup when lease recovery fails", async () => {
    vi.useFakeTimers();
    const error = new Error("Reaper unavailable.");
    const request = vi.fn(async (operation: string) => {
      if (operation === "reapExpiredLeases") throw error;
      return {};
    });
    const log = logger();
    const wake = vi.fn();
    const stop = startLeaseReaper(
      { request } as never,
      configuration() as never,
      log,
      new AbortController().signal,
      wake,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(wake).toHaveBeenCalledOnce();
    expect(request.mock.calls.map(([operation]) => operation)).toEqual([
      "reapExpiredLeases",
      "cleanupEvidenceAssets",
    ]);
    expect(log.error).toHaveBeenCalledWith({ error }, "Lease reaper failed.");
    await stop();
  });

  it("uses a five-second scheduling fallback while preserving the reaping interval", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ expiredCount: 0 }));
    const wake = vi.fn();
    const stop = startLeaseReaper(
      { request } as never,
      configuration(15) as never,
      logger(),
      new AbortController().signal,
      wake,
    );
    await vi.advanceTimersByTimeAsync(10000);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(wake).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenCalledTimes(2);
    await stop();
  });

  it("keeps scheduling wakes while reaping is active and drains that call on shutdown", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const recovered = Promise.withResolvers<{ expiredCount: number }>();
    const request = vi.fn(() => recovered.promise);
    const wake = vi.fn();
    const log = logger();
    const stop = startLeaseReaper(
      { request } as never,
      configuration() as never,
      log,
      controller.signal,
      wake,
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(request).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledTimes(3);
    controller.abort();
    let completed = false;
    const stopping = stop().then(() => {
      completed = true;
    });
    const again = stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(completed).toBe(false);
    expect(wake).toHaveBeenCalledTimes(3);
    recovered.resolve({ expiredCount: 1 });
    await Promise.all([stopping, again]);
    expect(completed).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      { expiredCount: 1 },
      "Expired worker leases were recovered.",
    );
  });

  it("preserves a reaping interval that is not a multiple of the fallback cadence", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ expiredCount: 0 }));
    const wake = vi.fn();
    const stop = startLeaseReaper(
      { request } as never,
      configuration(7) as never,
      logger(),
      new AbortController().signal,
      wake,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(wake).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(request).toHaveBeenCalledTimes(4);
    await stop();
  });

  it("isolates a scheduling wake error from reaping and evidence cleanup", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ expiredCount: 0 }));
    const error = new Error("Wake unavailable.");
    const log = logger();
    const stop = startLeaseReaper(
      { request } as never,
      configuration() as never,
      log,
      new AbortController().signal,
      () => {
        throw error;
      },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith({ error }, "Scheduling wake failed.");
    await stop();
  });

  it("does not start fallback work when shutdown already began", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn();
    const wake = vi.fn();
    const stop = startLeaseReaper(
      { request } as never,
      configuration() as never,
      logger(),
      controller.signal,
      wake,
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    await stop();
  });
});
